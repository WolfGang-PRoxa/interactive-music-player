/**
 * Vérifie la résolution d'une piste avant transcodage — le vrai
 * PreloadManager, avec un lecteur simulé.
 *
 * Le tableau de bord recevait par moments un `audio/mpeg` parfaitement vide :
 * la barre de progression avançait et rien ne sortait. La cause tenait à ce
 * qu'une piste n'est pas toujours ce qu'elle paraît. Rangée dans une playlist,
 * elle est relue du disque comme un objet nu — titre, auteur, URL — que rien
 * ne relie au lecteur. Remise telle quelle à un extracteur, elle en obtient un
 * flux qui ne produit rien, sans lever la moindre erreur.
 *
 * D'où l'apparente loterie : un morceau déjà mis en cache par le préchargement
 * s'entendait, le même joué en direct restait muet. Le préchargement, lui,
 * hydratait la piste avant de la streamer ; la route `/api/stream` ne le
 * faisait pas.
 *
 * Ce test tient les deux bouts de la recette désormais partagée :
 * `resolvePlayableTrack`, qui rend la piste jouable, et `resolveAudioInput`,
 * qui ramène les quatre formes qu'un extracteur peut rendre aux deux seules
 * que ffmpeg connaisse.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const preloadManager = require('../src/audio/PreloadManager');

let failed = 0;
let passed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Lecteur simulé.
 *
 * `search` rend la piste hydratée — celle qu'un vrai lecteur reconstruit à
 * partir de l'URL, avec son extracteur. `extractors.run` reproduit la boucle de
 * discord-player : il essaie l'extracteur et remonte ce qu'il rend.
 */
function fakePlayer({ hydrated = null, streamResult = null, searchThrows = false } = {}) {
    const calls = { search: 0, stream: 0 };

    const extractor = {
        identifier: 'fake-extractor',
        constructor: { name: 'FakeExtractor' },
        validate: async () => true,
        stream: async () => { calls.stream++; return streamResult; },
    };

    const track = hydrated
        ? { ...hydrated, extractor }
        : null;

    return {
        calls,
        extractor,
        search: async () => {
            calls.search++;
            if (searchThrows) throw new Error('search down');
            return { tracks: track ? [track] : [] };
        },
        extractors: {
            store: new Map([['fake', extractor]]),
            run: async (fn) => {
                const result = await fn(extractor);
                return result === false ? null : { result, extractor };
            },
            stream: async () => { calls.stream++; return streamResult; },
        },
    };
}

/** Rend le lecteur au préchargeur après chaque scénario. */
function withPlayer(player, fn) {
    const previous = preloadManager.player;
    preloadManager.player = player;
    return Promise.resolve(fn()).finally(() => { preloadManager.player = previous; });
}

/**
 * Une URL qui n'est pas en http(s) : la piste reste locale au test.
 *
 * C'est ce qui écarte le recours à youtube-dl-exec, dernier filet de
 * `resolveAudioInput` — il sortirait sur le réseau, et un test ne doit pas en
 * dépendre.
 */
const LOCAL_URL = 'file://morceau-de-test.opus';

(async () => {
    console.log('\n=== The track resolved before transcoding ===\n');

    // 1. Une piste nue de playlist est hydratée avant tout le reste.
    {
        const player = fakePlayer({ hydrated: { title: 'Titre', url: LOCAL_URL } });
        await withPlayer(player, async () => {
            const bare = { title: 'Titre', author: 'Quelqu\'un', url: LOCAL_URL, queryType: 'youtube' };
            const resolved = await preloadManager.resolvePlayableTrack(bare);

            check('a bare playlist track goes through player.search', player.calls.search === 1,
                `${player.calls.search} call(s)`);
            check('and comes back with an extractor',
                !!resolved.track.extractor && typeof resolved.track.extractor.stream === 'function');
            check('its URL is carried over', resolved.url === LOCAL_URL, resolved.url);
        });
    }

    // 2. Une piste déjà jouable n'est pas hydratée une seconde fois.
    {
        const player = fakePlayer({ hydrated: { title: 'Titre', url: LOCAL_URL } });
        await withPlayer(player, async () => {
            const ready = { title: 'Titre', url: LOCAL_URL, extractor: player.extractor };
            await preloadManager.resolvePlayableTrack(ready);
            check('an already playable track is left alone', player.calls.search === 0,
                `${player.calls.search} call(s) to search`);
        });
    }

    // 3. Une recherche en échec ne fait pas tomber la résolution : la piste
    //    d'origine est rendue telle quelle, à charge pour la suite de trancher.
    {
        const player = fakePlayer({ searchThrows: true });
        await withPlayer(player, async () => {
            const bare = { title: 'Titre', url: LOCAL_URL };
            const resolved = await preloadManager.resolvePlayableTrack(bare);
            check('a failing search still yields a track', resolved && resolved.track.title === 'Titre');
        });
    }

    // 4. Les quatre formes qu'un extracteur peut rendre.
    {
        const cases = [
            ['a direct URL string', 'https://cdn.example/audio.webm',
                (r) => r.ffmpegInput === 'https://cdn.example/audio.webm' && !r.inputStream],
            ['an object carrying a URL', { url: 'https://cdn.example/audio.webm' },
                (r) => r.ffmpegInput === 'https://cdn.example/audio.webm' && !r.inputStream],
            ['a readable stream', Readable.from(['xxx']),
                (r) => r.ffmpegInput === 'pipe:0' && !!r.inputStream],
            ['an object wrapping a stream', { stream: Readable.from(['xxx']) },
                (r) => r.ffmpegInput === 'pipe:0' && !!r.inputStream],
        ];

        for (const [label, streamResult, verify] of cases) {
            const player = fakePlayer({ streamResult });
            await withPlayer(player, async () => {
                const track = { title: 'Titre', url: LOCAL_URL, extractor: player.extractor };
                const resolved = await preloadManager.resolveAudioInput(track, LOCAL_URL);
                check(`ffmpeg is fed from ${label}`, verify(resolved),
                    `${resolved.ffmpegInput} / ${resolved.inputStream ? 'stream' : 'no stream'}`);
            });
        }
    }

    // 5. Rien de jouable : les deux entrées sont nulles.
    //
    // C'est la seule façon pour la route de savoir qu'elle n'a rien à envoyer,
    // et donc de répondre une erreur plutôt qu'un `200 OK` vide — le cas même
    // qui laissait la barre de progression avancer en silence.
    {
        const player = fakePlayer({ streamResult: null });
        await withPlayer(player, async () => {
            const track = { title: 'Titre', url: LOCAL_URL, extractor: player.extractor };
            const resolved = await preloadManager.resolveAudioInput(track, LOCAL_URL);
            check('an unresolvable track yields no input at all',
                !resolved.ffmpegInput && !resolved.inputStream,
                `${resolved.ffmpegInput} / ${resolved.inputStream ? 'stream' : 'no stream'}`);
        });
    }

    // 6. Les fichiers du disque entrent dans le cache comme les autres.
    //
    // Ils en étaient exclus au motif qu'ils sont « déjà locaux » — vrai pour le
    // bot, faux pour le navigateur qui les écoute : en diffusion personnelle, un
    // WAV de trente mégaoctets traverse le réseau à chaque lecture.
    {
        const tmp = path.join(os.tmpdir(), `preload-test-${process.pid}.wav`);
        fs.writeFileSync(tmp, Buffer.alloc(2048));

        try {
            const localTrack = { title: 'Téléversé', url: tmp, queryType: 'file' };
            check('a file on disk gets a cache key', !!preloadManager.getTrackKey(localTrack));

            const ghost = { title: 'Disparu', url: path.join(os.tmpdir(), 'nulle-part.wav'), queryType: 'file' };
            check('a path leading nowhere gets none', preloadManager.getTrackKey(ghost) === null,
                'otherwise it would be searched for as plain text, and bring back anything');

            const player = fakePlayer({ streamResult: 'https://cdn.example/pas-ici.webm' });
            await withPlayer(player, async () => {
                const resolved = await preloadManager.resolveAudioInput(localTrack, tmp);
                check('ffmpeg reads it straight from its path', resolved.ffmpegInput === tmp,
                    resolved.ffmpegInput);
                check('no extractor is bothered for it', player.calls.stream === 0,
                    `${player.calls.stream} call(s)`);
            });
        } finally {
            try { fs.unlinkSync(tmp); } catch (e) {}
        }
    }

    // 7. Le transcodage écarte l'image, sans quoi il ne produit rien.
    //
    // Un fichier téléversé porte souvent sa pochette en flux MJPEG. Le muxer MP3
    // ne sait la ranger que dans une étiquette ID3v2, désactivée ici : ffmpeg
    // s'arrête alors sur « nothing was written into output file ».
    {
        const preloadSource = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'audio', 'PreloadManager.js'), 'utf8');
        check('the preload transcode drops the video stream',
            /ffmpegArgs\.push\('-vn'\)/.test(preloadSource),
            'without -vn, any file carrying artwork fails to transcode at all');

        const apiSource = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'web', 'routes', 'api.js'), 'utf8');
        const streamRoute = apiSource.slice(apiSource.indexOf("router.get('/stream'"),
            apiSource.indexOf("router.get('/download'"));
        check('the live transcode drops it too', streamRoute.includes("'-vn'"));
    }

    // 8. Le téléchargement repart de l'original, jamais de la copie du cache.
    {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'web', 'routes', 'api.js'), 'utf8');
        const downloadRoute = source.slice(source.indexOf("router.get('/download'"),
            source.indexOf("router.get('/video-info'"));

        const localFirst = downloadRoute.indexOf('resolveMediaPath(track.url)');
        const cacheAfter = downloadRoute.indexOf('cachedPath && fs.existsSync(cachedPath)');
        check('the download prefers the original file over the cached copy',
            localFirst !== -1 && cacheAfter !== -1 && localFirst < cacheAfter,
            'otherwise a WAV export would be re-encoded from an MP3');
    }

    // 9. La route de flux ne peut plus streamer une piste sans l'avoir résolue.
    {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'web', 'routes', 'api.js'), 'utf8');
        const streamRoute = source.slice(source.indexOf("router.get('/stream'"),
            source.indexOf("router.get('/download'"));

        check('the /stream route goes through resolvePlayableTrack',
            streamRoute.includes('resolvePlayableTrack'),
            'without it, a playlist track streams nothing at all');
        check('and writes its header only once a byte has come out',
            /stdout\.once\('data'/.test(streamRoute),
            'a header sent up front turns a failure into an empty 200 OK');
    }

    // 10. Après plusieurs échecs, le préchargeur va voir si yt-dlp a vieilli.
    //
    // YouTube change ses défenses toutes les quelques semaines et yt-dlp suit ;
    // un binaire de dix jours fait échouer toutes les pistes distantes sans
    // qu'aucun message ne désigne la version. Reste à ne pas interroger GitHub
    // au moindre hoquet de réseau.
    {
        const asked = [];
        const installed = preloadManager._installedYtdlpVersion;
        const latest = preloadManager._latestYtdlpVersion;
        preloadManager._installedYtdlpVersion = async () => { asked.push('installed'); return '2026.08.19'; };
        preloadManager._latestYtdlpVersion = async () => { asked.push('latest'); return '2026.08.28'; };

        try {
            const remote = { title: 'Distante', url: 'https://youtube.com/watch?v=x' };

            preloadManager._lastVersionCheckAt = 0;
            await preloadManager._checkYtdlpFreshness(remote, 1);
            await preloadManager._checkYtdlpFreshness(remote, 2);
            check('one or two failures ask nothing of GitHub', asked.length === 0,
                asked.join(', ') || 'nothing asked');

            await preloadManager._checkYtdlpFreshness(remote, 3);
            check('the third failure looks the version up', asked.length === 2, asked.join(', '));

            asked.length = 0;
            await preloadManager._checkYtdlpFreshness(remote, 3);
            check('and it is not asked again within the hour', asked.length === 0,
                asked.join(', ') || 'nothing asked');

            preloadManager._lastVersionCheckAt = 0;
            asked.length = 0;
            await preloadManager._checkYtdlpFreshness(
                { title: 'Locale', url: 'C:\\musique\\morceau.wav' }, 3);
            check('a local file never triggers it', asked.length === 0,
                'yt-dlp has nothing to do with a file on disk');
        } finally {
            preloadManager._installedYtdlpVersion = installed;
            preloadManager._latestYtdlpVersion = latest;
            preloadManager._lastVersionCheckAt = 0;
        }
    }

    // 11. La vidéo servie au navigateur n'est jamais un manifeste.
    //
    // Une vidéo refusait de se charger, et le tableau de bord redemandait dix
    // fois la même adresse : un `.m3u8`. Ce n'est pas un flux mais une liste de
    // morceaux, qu'une balise <video> ne sait pas lire hors de Safari, et dont
    // l'adresse — signée pour le client qui l'a demandée — répond 404 à tout
    // autre.
    //
    // Le piège tient au classement. `pickVideoFormat` départage à définition
    // égale par le débit, et les manifestes annoncent le plus haut de la liste :
    // 4107 contre 1666 en 720p sur la vidéo du signalement. Ils gagnaient donc
    // à tout coup, et il ne suffit pas de mieux trier — il faut les écarter
    // avant.
    {
        const vm = require('vm');
        // Fins de ligne ramenées à \n : sous Windows, Git extrait souvent en CRLF,
        // et la recherche de la fin de fonction ci-dessous ne trouverait rien.
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'src', 'web', 'routes', 'api.js'), 'utf8').replace(/\r\n/g, '\n');
        const videoSource = require(path.join(__dirname, '..', 'src', 'audio', 'videoSource.js'));

        // Le choix est extrait du fichier livré : le recopier ici laisserait le
        // test passer pendant que la route, elle, aurait changé d'avis.
        const debut = source.indexOf('function codecRank(');
        const fin = source.indexOf('\n}\n', source.indexOf('function pickVideoFormat(')) + 3;
        const bac = { console };
        bac.globalThis = bac;
        vm.createContext(bac);
        vm.runInContext(`${source.slice(debut, fin)}\nglobalThis.__f = pickVideoFormat;`, bac);
        const choisir = bac.__f;

        const image = (o) => Object.assign({
            vcodec: 'avc1.640020', acodec: 'none', protocol: 'https', ext: 'mp4',
            url: `https://exemple/${o.format_id}`, width: 1280, height: 720,
        }, o);
        const entry = {
            formats: [
                image({ format_id: '311', protocol: 'm3u8_native', tbr: 4107.6 }),
                image({ format_id: '298', tbr: 1666.2 }),
                image({ format_id: '302', vcodec: 'vp9', tbr: 1081.3 }),
            ],
        };

        // Le comportement d'avant, reproduit : c'est lui qui a cassé la lecture.
        check('unfiltered, the manifest wins on bitrate alone',
            choisir(entry.formats, 720).format_id === '311',
            'sorting better would not help: it has to be excluded first');

        const jouables = videoSource.videoTracks(entry)
            .filter(f => f.acodec === 'none' && (f.ext === 'mp4' || f.container === 'mp4'));
        check('  … filtered, a real stream is served', choisir(jouables, 720).format_id === '298',
            'https, playable by a <video> tag');

        check('the route funnels every bucket through the filter',
            /const jouables = videoSource\.videoTracks\(entry\);/.test(source)
            && /const anyVideoFormats = jouables;/.test(source),
            'one bucket left unfiltered would bring the manifest back as a fallback');

        // La même route sert aussi le son, et tombait sur les deux mêmes
        // écueils : un manifeste, et un doublage automatique pris au hasard.
        check('the audio it serves goes through the shared choice',
            (source.match(/videoSource\.bestAudio\(entry\)/g) || []).length === 2
            && !/audioFormats\.find\(f => f\.vcodec === 'none'\)/.test(source),
            'first in the list is a manifest in a language nobody asked for');
    }

    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
