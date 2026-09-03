<#
    start-bot.ps1 — Démarre le bot sans aucune fenêtre de console.

    Cible réelle du raccourci créé par l'assistant, et de « Start bot.vbs » à la
    racine : le .vbs appelle ce script en mode caché. Aucun terminal n'apparaît
    donc à l'écran ni dans la barre des tâches, ni pendant les vérifications, ni
    pendant que le bot tourne.

    La console servait à trois choses, toutes reprises ailleurs :
      - suivre le démarrage → la fenêtre de lancement ci-dessous ;
      - lire les erreurs → cette même fenêtre, et data/logs/ pour le détail ;
      - arrêter le bot → bouton d'extinction du tableau de bord.

    La fenêtre de lancement liste les étapes du démarrage et s'efface d'elle-même
    dès que le tableau de bord répond. En cas d'échec elle reste ouverte, porte
    le motif et l'action qui débloque la situation, plutôt que de laisser
    l'utilisateur devant un lancement qui n'a rien produit.

    Encodage : UTF-8 **avec BOM** (voir create-shortcut.ps1).
#>

[CmdletBinding()]
param(
    # Construit l'interface sans l'afficher et sans rien démarrer : sert à
    # vérifier le XAML et le câblage des étapes.
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml

# Sans console, une erreur non rattrapée serait invisible.
trap {
    try {
        [void][System.Windows.MessageBox]::Show(
            "Le démarrage a échoué.`n`n" + $_.Exception.Message,
            'Interactive Music Player',
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Error)
    } catch {
        Write-Error $_.Exception.Message
    }
    exit 1
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$IconPath    = Join-Path $PSScriptRoot 'icon.ico'
$LogFolder   = Join-Path $ProjectRoot 'data\logs'
$EnvFile     = Join-Path $ProjectRoot '.env'
$LatestLog   = Join-Path $LogFolder 'latest.log'

# ============================================================================
#  Utilitaires
# ============================================================================

function TailOf {
    # Les dernières lignes d'un journal, pour donner un motif à un échec.
    param([string]$Path, [int]$Lines = 12)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    try {
        return (Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop) -join [Environment]::NewLine
    } catch {
        return ''
    }
}

function StartHidden {
    <#
        Lance un processus sans fenêtre et rend l'objet processus.

        Attention : surtout pas de -RedirectStandardOutput ici. Sous Windows
        PowerShell 5.1, l'objet renvoyé par Start-Process -PassThru a alors un
        ExitCode toujours nul, y compris après la fin du processus — une
        réussite se lirait comme un échec. Les journaux de npm sont donc
        obtenus par la redirection de cmd lui-même, dans la commande.
    #>
    param([string]$FilePath, [string]$Arguments)

    return Start-Process -FilePath $FilePath -ArgumentList $Arguments `
        -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
}

function ReadEnvFile {
    # Lecture volontairement naïve : on n'y cherche que le jeton Discord, le
    # port et le jeton du tableau de bord. dotenv reste seul maître de
    # l'interprétation du fichier côté bot.
    $values = @{}
    if (-not (Test-Path -LiteralPath $EnvFile)) { return $values }
    try {
        foreach ($line in (Get-Content -LiteralPath $EnvFile -ErrorAction Stop)) {
            if ($line -match '^\s*#') { continue }
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
                $values[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
            }
        }
    } catch { }
    return $values
}

function EnvValue {
    param([string]$Name, [string]$Default = '')
    $values = ReadEnvFile
    if ($values.ContainsKey($Name) -and $values[$Name]) { return $values[$Name] }
    return $Default
}

function DashboardPort {
    $raw = EnvValue 'PORT' '3000'
    $parsed = 0
    if (-not [int]::TryParse($raw, [ref]$parsed)) { $parsed = 3000 }
    return $parsed
}

function DashboardToken {
    # Le jeton vient de DASHBOARD_TOKEN s'il est renseigné, sinon de
    # data/dashboard-token que le bot écrit à son premier démarrage (voir
    # src/web/auth.js). Il ouvre aussi bien l'interface que /api et la WebSocket.
    $token = EnvValue 'DASHBOARD_TOKEN'
    if ($token) { return $token }
    $tokenFile = Join-Path $ProjectRoot 'data\dashboard-token'
    if (Test-Path -LiteralPath $tokenFile) {
        try { return (Get-Content -LiteralPath $tokenFile -Raw -ErrorAction Stop).Trim() } catch { }
    }
    return ''
}

function DashboardUrl {
    <#
        Reconstitue l'adresse du tableau de bord, jeton compris.

        La machine ne s'appelle surtout pas $host : c'est une variable réservée
        de PowerShell, en lecture seule.
    #>
    $machine = EnvValue 'HOST' '127.0.0.1'
    if ($machine -eq '0.0.0.0' -or $machine -eq '::') { $machine = 'localhost' }
    $port = DashboardPort

    $url = "http://${machine}:${port}/"
    $token = DashboardToken
    if ($token) { $url += "?token=$token" }
    return $url
}

function DashboardClients {
    <#
        Combien de tableaux de bord sont connectés ? Rend -1 si la question n'a
        pas pu être posée — le doute ne doit pas se lire comme « aucun onglet ».

        Le point d'accès est /api/clients (voir src/web/routes/api.js) ; le
        jeton passe en query, forme acceptée par auth.extractToken.

        L'appel est synchrone et bloque donc le fil de l'interface : le délai
        reste court, d'autant qu'on ne le pose qu'à un serveur dont le port
        vient de répondre.
    #>
    param([int]$TimeoutSec = 2)

    $port = $script:Port
    $token = DashboardToken
    $uri = "http://127.0.0.1:$port/api/clients"
    if ($token) { $uri += "?token=$token" }

    try {
        $answer = Invoke-RestMethod -Uri $uri -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        if ($null -eq $answer.count) { return -1 }
        return [int]$answer.count
    } catch {
        return -1
    }
}

function SendBotCommand {
    <#
        Envoie au bot une commande du tableau de bord, par le même canal que
        celui-ci : une WebSocket authentifiée. Aucun point d'accès HTTP n'est
        ajouté pour l'occasion — `shutdownBot` et `restartBot` existent déjà
        (src/web/websocket/handlers/systemHandlers.js) et rien ne justifie
        d'exposer l'extinction du process une seconde fois.

        L'appel bloque le fil de l'interface le temps de la poignée de main,
        d'où le délai court : on parle à une socket locale.
    #>
    param([string]$Type, [int]$TimeoutMs = 4000)

    $token = DashboardToken
    $uri = "ws://127.0.0.1:$($script:Port)/"
    if ($token) { $uri += "?token=$token" }

    $socket = New-Object System.Net.WebSockets.ClientWebSocket
    $cancel = New-Object System.Threading.CancellationTokenSource($TimeoutMs)
    try {
        # [void] n'est pas décoratif : GetResult() sur une Task non générique
        # dépose un VoidTaskResult dans le flux de sortie, et la fonction
        # rendrait un tableau au lieu du booléen attendu.
        [void]$socket.ConnectAsync([Uri]$uri, $cancel.Token).GetAwaiter().GetResult()

        $payload = [System.Text.Encoding]::UTF8.GetBytes("{""type"":""$Type""}")
        $segment = New-Object System.ArraySegment[byte](, $payload)
        [void]$socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text,
            $true, $cancel.Token).GetAwaiter().GetResult()

        # Le serveur traite le message de façon asynchrone — extinction avec
        # fondu, redémarrage par respawn. Fermer la socket dans la foulée
        # couperait avant qu'il ne l'ait lu ; on lui laisse un instant, puis on
        # part sans attendre la poignée de main de fermeture, qu'un process en
        # train de mourir n'achèvera pas.
        [System.Threading.Thread]::Sleep(250)
        return $true
    } catch {
        return $false
    } finally {
        try { $socket.Dispose() } catch { }
        $cancel.Dispose()
    }
}

function PortAnswers {
    <#
        Le serveur du tableau de bord accepte-t-il une connexion ? C'est le seul
        signal fiable que le bot est réellement prêt : il n'ouvre son port
        qu'une fois connecté à Discord (voir l'événement ClientReady dans
        src/index.js).

        L'attente est volontairement courte — la fonction est appelée depuis le
        fil de l'interface, qu'elle ne doit pas figer. En local, un port fermé
        se solde de toute façon par un refus immédiat.
    #>
    param([int]$Port, [int]$TimeoutMs = 120)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# ============================================================================
#  Première configuration
# ============================================================================

<#
    Ce que le bot réclame et que personne ne peut lui donner à sa place : sa
    propre application Discord. L'étape est incompressible — un jeton désigne
    une application, il ne se partage pas et ne se devine pas — mais tout ce
    qui l'entoure peut disparaître, et c'est l'objet de cette section.

    Ce qui reste à faire à la main : créer l'application sur le portail, et
    copier le jeton. Rien d'autre. L'identifiant de l'application n'est pas
    demandé, il se déduit du jeton ; le fichier .env n'est pas ouvert, il est
    écrit ; l'URL d'invitation n'est pas assemblée dans le portail, elle est
    construite ici avec les bonnes portées et les bonnes permissions.
#>

# Le portail développeur. Ouvert tel quel, sans viser l'onglet « Bot » : à ce
# moment-là l'application n'existe pas encore, il n'y a pas d'identifiant par
# lequel l'atteindre.
$DiscordPortal = 'https://discord.com/developers/applications'

# Discord demande un agent utilisateur de cette forme sur les appels à son API,
# et sa protection de façade écarte ce qui n'en porte pas.
$ApiUserAgent = 'DiscordBot (https://github.com/WolfGang-PRoxa/interactive_music_player, 1.0)'

<#
    Permissions demandées à l'invitation, dans l'ordre du README.

    Écrites en décalages plutôt qu'en somme toute faite : « 19923984 » ne se
    relit pas, et la moindre correction future se ferait à l'aveugle.
#>
$InvitePermissions =
    (1 -shl 10) +   # View Channels
    (1 -shl 20) +   # Connect
    (1 -shl 21) +   # Speak
    (1 -shl  4) +   # Manage Channels
    (1 -shl 24)     # Move Members

function InviteUrl {
    # Les deux portées sont celles du README : `bot` pose le bot dans le salon,
    # `applications.commands` autorise ses commandes slash.
    param([string]$ClientId)
    return "https://discord.com/oauth2/authorize?client_id=$ClientId" +
           "&permissions=$InvitePermissions&scope=bot+applications.commands"
}

function LooksLikeBotToken {
    <#
        Trois segments base64url séparés par des points : la forme d'un jeton de
        bot. Le test reste large à dessein — il ne décide pas si le jeton est
        bon, seulement s'il vaut la peine d'aller le demander à Discord, qui
        seul tranche.
    #>
    param([string]$Text)
    if (-not $Text) { return $false }
    return ($Text.Trim() -match '^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$')
}

function ValidateBotToken {
    <#
        Demande à Discord ce que vaut ce jeton, et de quelle application il
        relève.

        `/oauth2/applications/@me` rend l'application elle-même. Son identifiant
        est exactement ce qu'attend DISCORD_CLIENT_ID : l'utilisateur n'a donc
        pas à le relever à la main sur le portail, ce qui retire une valeur à
        recopier sur les deux — et avec elle l'erreur de confondre l'identifiant
        de l'application avec celui du bot.

        La réponse porte aussi le nom de l'application, qui sert de preuve
        lisible : voir « Interactive Music Player reconnu » vaut mieux qu'une
        coche verte sur une suite de caractères que personne ne peut relire.

        L'appel est synchrone et fige donc brièvement la fenêtre, comme
        DashboardClients plus haut. C'est une requête, et l'interface n'a rien
        d'autre à faire en l'attendant.
    #>
    param([string]$Token)

    # Windows PowerShell 5.1 n'active pas TLS 1.2 partout selon l'âge de la
    # machine, et Discord ne descend pas en deçà : sans cette ligne l'appel
    # échoue sur une connexion fermée, qu'on prendrait pour une panne de réseau.
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch { }

    try {
        $app = Invoke-RestMethod -Uri 'https://discord.com/api/v10/oauth2/applications/@me' `
            -Headers @{ Authorization = "Bot $($Token.Trim())" } `
            -UserAgent $ApiUserAgent -TimeoutSec 12 -ErrorAction Stop

        if (-not $app.id) { return @{ Ok = $false; Reason = 'rejected' } }
        return @{ Ok = $true; Id = [string]$app.id; Name = [string]$app.name }
    } catch {
        # 401 comme 403 disent la même chose à l'utilisateur : ce jeton-là n'est
        # pas le bon. Tout le reste — DNS, proxy, câble — est une panne de
        # liaison, et lui reprocher son jeton l'enverrait corriger ce qui va
        # bien.
        $status = 0
        if ($_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        }
        if ($status -eq 401 -or $status -eq 403) { return @{ Ok = $false; Reason = 'rejected' } }
        return @{ Ok = $false; Reason = 'offline'; Message = $_.Exception.Message }
    }
}

function SetEnvValues {
    <#
        Inscrit des valeurs dans .env sans toucher au reste du fichier.

        Les commentaires de .env.example expliquent chaque variable, une par
        une ; réécrire le fichier en un minimum de deux lignes priverait
        l'utilisateur de tout ce qu'il pourrait vouloir régler ensuite — le
        port, l'exposition réseau, ses dossiers de musique.

        Écrit par .NET en UTF-8 **sans BOM**, et non par Set-Content : celui-ci
        pose un BOM que dotenv rattacherait au nom de la première variable, qui
        deviendrait invisible pour le bot.
    #>
    param([hashtable]$Values)

    $lines = @()
    if (Test-Path -LiteralPath $EnvFile) {
        $lines = @(Get-Content -LiteralPath $EnvFile -ErrorAction Stop)
    }

    $remaining = @{}
    foreach ($key in $Values.Keys) { $remaining[$key] = $Values[$key] }

    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
            $key = $matches[1]
            if ($remaining.ContainsKey($key)) {
                $lines[$i] = "$key=$($remaining[$key])"
                $remaining.Remove($key)
            }
        }
    }

    # Une variable absente du fichier — .env écrit à la main, exemple modifié —
    # est ajoutée en fin plutôt que perdue en silence.
    foreach ($key in @($remaining.Keys)) { $lines += "$key=$($remaining[$key])" }

    [System.IO.File]::WriteAllLines($EnvFile, [string[]]$lines,
        (New-Object System.Text.UTF8Encoding($false)))
}

function ClipboardText {
    <#
        Le presse-papiers peut être verrouillé par l'application qui vient d'y
        écrire. L'accès lève alors, et une exception par battement d'horloge n'a
        pas sa place dans une fenêtre dont c'est le métier d'attendre un collage.
    #>
    try {
        if ([System.Windows.Clipboard]::ContainsText()) {
            return [System.Windows.Clipboard]::GetText()
        }
    } catch { }
    return ''
}

# ============================================================================
#  Fenêtre de lancement
# ============================================================================

<#
    Palette et formes reprises du tableau de bord (src/web/public/css/base.css)
    et de l'assistant de raccourci : même ardoise, même bleu Discord, mêmes
    halos, même note de musique. Le logo est dessiné en vectoriel plutôt que
    chargé depuis icon.ico : ce fichier peut ne pas exister — seul l'assistant
    l'écrit — alors que la fenêtre, elle, s'affiche à chaque lancement.
#>

$LaunchXaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Interactive Music Player"
        Width="452" SizeToContent="Height"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" WindowStartupLocation="Manual" Topmost="True"
        ShowInTaskbar="False"
        UseLayoutRounding="True" SnapsToDevicePixels="True"
        TextOptions.TextFormattingMode="Ideal"
        FontFamily="Segoe UI Variable Text, Segoe UI">

  <Window.Resources>

    <LinearGradientBrush x:Key="NoteGradient" StartPoint="0,0" EndPoint="1,1">
      <GradientStop Offset="0"   Color="#38BDF8"/>
      <GradientStop Offset="0.5" Color="#818CF8"/>
      <GradientStop Offset="1"   Color="#C084FC"/>
    </LinearGradientBrush>

    <LinearGradientBrush x:Key="ActionGradient" StartPoint="0,0" EndPoint="1,1">
      <GradientStop Offset="0" Color="#5865F2"/>
      <GradientStop Offset="1" Color="#8E44AD"/>
    </LinearGradientBrush>

    <LinearGradientBrush x:Key="ActionGradientHover" StartPoint="0,0" EndPoint="1,1">
      <GradientStop Offset="0" Color="#6D78FF"/>
      <GradientStop Offset="1" Color="#A855C7"/>
    </LinearGradientBrush>

    <Style x:Key="PrimaryButton" TargetType="Button">
      <Setter Property="Foreground" Value="#FFFFFF"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Height" Value="38"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Fill" CornerRadius="11" Padding="20,0"
                    Background="{StaticResource ActionGradient}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Fill" Property="Background" Value="{StaticResource ActionGradientHover}"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Fill" Property="Opacity" Value="0.82"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="SecondaryButton" TargetType="Button">
      <Setter Property="Foreground" Value="#C9C6D6"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="Height" Value="38"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Fill" CornerRadius="11" Padding="18,0"
                    Background="#00FFFFFF" BorderBrush="#24FFFFFF" BorderThickness="1">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Fill" Property="Background" Value="#14FFFFFF"/>
                <Setter TargetName="Fill" Property="BorderBrush" Value="#3DFFFFFF"/>
                <Setter Property="Foreground" Value="#F5F4F8"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Fill" Property="Opacity" Value="0.75"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Carte d'action : le survol est traité par déclencheur plutôt qu'en
         code, il n'y a ici aucun état à mémoriser. -->
    <Style x:Key="ActionCard" TargetType="Border">
      <Setter Property="Background" Value="#0DFFFFFF"/>
      <Setter Property="BorderBrush" Value="#1AFFFFFF"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Margin" Value="0,0,0,8"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="#17FFFFFF"/>
          <Setter Property="BorderBrush" Value="#36FFFFFF"/>
        </Trigger>
      </Style.Triggers>
    </Style>

    <!-- Champ de collage du jeton. Un TextBox ne s'arrondit pas par une
         propriété : il faut lui refaire un gabarit, dont le ScrollViewer doit
         garder le nom PART_ContentHost — c'est par ce nom que le contrôle
         retrouve où écrire. -->
    <Style x:Key="PasteBox" TargetType="TextBox">
      <Setter Property="Foreground" Value="#F5F4F8"/>
      <Setter Property="CaretBrush" Value="#7A85FF"/>
      <Setter Property="SelectionBrush" Value="#5865F2"/>
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="FontFamily" Value="Cascadia Mono, Consolas"/>
      <Setter Property="Height" Value="36"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="TextBox">
            <Border x:Name="Fill" CornerRadius="10" Padding="12,0"
                    Background="#0DFFFFFF" BorderBrush="#24FFFFFF" BorderThickness="1">
              <ScrollViewer x:Name="PART_ContentHost" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsFocused" Value="True">
                <Setter TargetName="Fill" Property="BorderBrush" Value="#5865F2"/>
              </Trigger>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Fill" Property="BorderBrush" Value="#3DFFFFFF"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="CloseButtonStyle" TargetType="Button">
      <Setter Property="Width" Value="30"/>
      <Setter Property="Height" Value="30"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Fill" CornerRadius="8" Background="#00FFFFFF">
              <Path Data="M0,0 L9,9 M9,0 L0,9" Stroke="#6F6C80" StrokeThickness="1.4"
                    x:Name="Cross" HorizontalAlignment="Center" VerticalAlignment="Center"
                    StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Fill" Property="Background" Value="#33ED4245"/>
                <Setter TargetName="Cross" Property="Stroke" Value="#FFFFFF"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

  </Window.Resources>

  <!-- Coque : marge réservée à l'ombre portée -->
  <Border x:Name="Surface" Margin="20" CornerRadius="18" BorderThickness="1" Opacity="0">
    <Border.BorderBrush>
      <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
        <GradientStop Offset="0" Color="#2EFFFFFF"/>
        <GradientStop Offset="1" Color="#12FFFFFF"/>
      </LinearGradientBrush>
    </Border.BorderBrush>
    <Border.Background>
      <LinearGradientBrush StartPoint="0,0" EndPoint="0.6,1">
        <GradientStop Offset="0" Color="#16131F"/>
        <GradientStop Offset="1" Color="#0A090F"/>
      </LinearGradientBrush>
    </Border.Background>
    <Border.Effect>
      <DropShadowEffect BlurRadius="32" ShadowDepth="9" Direction="270" Opacity="0.55" Color="#000000"/>
    </Border.Effect>
    <Border.RenderTransform>
      <TranslateTransform x:Name="SurfaceSlide" Y="14"/>
    </Border.RenderTransform>

    <Grid ClipToBounds="True">

      <!-- Halos décoratifs, comme sur le tableau de bord -->
      <Ellipse Width="330" Height="330" Margin="0,-190,-150,0"
               HorizontalAlignment="Right" VerticalAlignment="Top" IsHitTestVisible="False">
        <Ellipse.Fill>
          <RadialGradientBrush>
            <GradientStop Offset="0" Color="#3D5865F2"/>
            <GradientStop Offset="1" Color="#005865F2"/>
          </RadialGradientBrush>
        </Ellipse.Fill>
      </Ellipse>
      <Ellipse Width="300" Height="300" Margin="-150,0,0,-180"
               HorizontalAlignment="Left" VerticalAlignment="Bottom" IsHitTestVisible="False">
        <Ellipse.Fill>
          <RadialGradientBrush>
            <GradientStop Offset="0" Color="#2EEB459E"/>
            <GradientStop Offset="1" Color="#00EB459E"/>
          </RadialGradientBrush>
        </Ellipse.Fill>
      </Ellipse>

      <Button x:Name="CloseButton" Style="{StaticResource CloseButtonStyle}"
              HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,10,10,0"/>

      <StackPanel Margin="26,24,26,22">

        <!-- En-tête : logo, titre, état courant. Sert aussi de poignée de
             déplacement — voir plus bas pourquoi elle ne peut pas être la
             fenêtre entière. -->
        <StackPanel x:Name="Header" Orientation="Horizontal" Background="#01FFFFFF">
          <Viewbox Width="42" Height="42" VerticalAlignment="Center">
            <Grid Width="64" Height="64">
              <Rectangle Width="60" Height="60" RadiusX="16" RadiusY="16"
                         Stroke="#40FFFFFF" StrokeThickness="1.5">
                <Rectangle.Fill>
                  <LinearGradientBrush StartPoint="0,0" EndPoint="1,1">
                    <GradientStop Offset="0" Color="#1E293B"/>
                    <GradientStop Offset="1" Color="#0F172A"/>
                  </LinearGradientBrush>
                </Rectangle.Fill>
              </Rectangle>
              <Path Fill="{StaticResource NoteGradient}">
                <Path.Data>
                  <!-- Nonzero, sinon les recouvrements hampe/tête et
                       ligature/hampe se perceraient mutuellement. -->
                  <GeometryGroup FillRule="Nonzero">
                    <EllipseGeometry Center="20,46" RadiusX="6.5" RadiusY="5">
                      <EllipseGeometry.Transform>
                        <RotateTransform Angle="-25" CenterX="20" CenterY="46"/>
                      </EllipseGeometry.Transform>
                    </EllipseGeometry>
                    <EllipseGeometry Center="44,40" RadiusX="6.5" RadiusY="5">
                      <EllipseGeometry.Transform>
                        <RotateTransform Angle="-25" CenterX="44" CenterY="40"/>
                      </EllipseGeometry.Transform>
                    </EllipseGeometry>
                    <RectangleGeometry Rect="23,14,3.5,32" RadiusX="1.5" RadiusY="1.5"/>
                    <RectangleGeometry Rect="47,8,3.5,32" RadiusX="1.5" RadiusY="1.5"/>
                    <PathGeometry Figures="M23,14 L50.5,8 L50.5,13.5 L23,19.5 Z"/>
                    <PathGeometry Figures="M23,21.5 L50.5,15.5 L50.5,21 L23,27 Z"/>
                  </GeometryGroup>
                </Path.Data>
              </Path>
            </Grid>
          </Viewbox>
          <StackPanel VerticalAlignment="Center" Margin="15,0,34,0">
            <TextBlock Text="Interactive Music Player"
                       Foreground="#F5F4F8" FontSize="16.5" FontWeight="SemiBold"/>
            <TextBlock x:Name="Headline" Text="Démarrage en cours…"
                       Foreground="#8C899D" FontSize="12.5" Margin="0,3,0,0"
                       TextWrapping="Wrap"/>
          </StackPanel>
        </StackPanel>

        <!-- Barre indéterminée : un bloc qui traverse la piste en boucle -->
        <Border x:Name="Track" Height="4" CornerRadius="2" Background="#14FFFFFF"
                Margin="0,20,0,0" ClipToBounds="True">
          <Border Width="120" HorizontalAlignment="Left" CornerRadius="2">
            <Border.Background>
              <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                <GradientStop Offset="0" Color="#005865F2"/>
                <GradientStop Offset="0.5" Color="#FF7A85FF"/>
                <GradientStop Offset="1" Color="#00EB459E"/>
              </LinearGradientBrush>
            </Border.Background>
            <Border.RenderTransform>
              <TranslateTransform x:Name="BarSlide" X="-120"/>
            </Border.RenderTransform>
          </Border>
        </Border>

        <!-- Étapes : une ligne par étape, ajoutées depuis le script -->
        <StackPanel x:Name="StepList" Margin="2,20,0,0"/>

        <!-- Cartes d'action : seulement quand le bot tourne déjà -->
        <StackPanel x:Name="CardList" Margin="0,14,0,0"/>

        <!--
             Première configuration.

             N'apparaît qu'au premier lancement, ou lorsque Discord refuse le
             jeton enregistré. Prend la place de la liste des étapes plutôt que
             de s'ajouter dessous : la croix rouge d'une vérification ratée ne
             ferait qu'inquiéter sur un poste où rien n'est encore cassé.

             Deux temps. Le premier mène au portail et attend le jeton ; le
             second, une fois l'application reconnue, mène à l'invitation.
        -->
        <StackPanel x:Name="SetupPanel" Visibility="Collapsed" Margin="0,16,0,0">

          <StackPanel x:Name="SetupStage1">

            <TextBlock Foreground="#8C899D" FontSize="12.5" TextWrapping="Wrap"
                       Text="Votre bot a besoin de sa propre application Discord. C'est gratuit, et à faire une seule fois."/>

            <Grid Margin="0,15,0,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="19"/>
                <ColumnDefinition Width="*"/>
              </Grid.ColumnDefinitions>
              <TextBlock Grid.Column="0" Text="1" Foreground="#7A85FF" FontSize="12.5" FontWeight="SemiBold"/>
              <TextBlock Grid.Column="1" Foreground="#B9B6C6" FontSize="12.5" TextWrapping="Wrap"
                         Text="Sur le portail : New Application, puis un nom."/>
            </Grid>
            <Grid Margin="0,7,0,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="19"/>
                <ColumnDefinition Width="*"/>
              </Grid.ColumnDefinitions>
              <TextBlock Grid.Column="0" Text="2" Foreground="#7A85FF" FontSize="12.5" FontWeight="SemiBold"/>
              <TextBlock Grid.Column="1" Foreground="#B9B6C6" FontSize="12.5" TextWrapping="Wrap"
                         Text="Onglet Bot, à gauche → Reset Token → Copy."/>
            </Grid>
            <Grid Margin="0,7,0,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="19"/>
                <ColumnDefinition Width="*"/>
              </Grid.ColumnDefinitions>
              <TextBlock Grid.Column="0" Text="3" Foreground="#7A85FF" FontSize="12.5" FontWeight="SemiBold"/>
              <TextBlock Grid.Column="1" Foreground="#B9B6C6" FontSize="12.5" TextWrapping="Wrap"
                         Text="Revenez ici : le jeton copié est reconnu tout seul."/>
            </Grid>

            <Button x:Name="PortalButton" Style="{StaticResource PrimaryButton}"
                    Margin="0,17,0,0" HorizontalAlignment="Stretch"
                    Content="Ouvrir le portail Discord"/>

            <!-- Le champ et son indication. WPF n'a pas de texte de repli
                 natif : c'est un libellé posé derrière, que la saisie fait
                 disparaître. IsHitTestVisible le rend transparent au clic,
                 sans quoi cliquer dessus ne donnerait pas le focus au champ. -->
            <Grid Margin="0,10,0,0">
              <TextBox x:Name="TokenBox" Style="{StaticResource PasteBox}"/>
              <TextBlock x:Name="TokenHint" IsHitTestVisible="False"
                         Foreground="#56536A" FontSize="11.5" Margin="13,0,0,0"
                         VerticalAlignment="Center"
                         Text="Le jeton copié apparaîtra ici"/>
            </Grid>

            <TextBlock x:Name="SetupStatus" Foreground="#6F6C80" FontSize="11.5"
                       Margin="2,8,0,0" TextWrapping="Wrap"
                       Text="En attente du jeton. Vous pouvez aussi le coller ci-dessus."/>
          </StackPanel>

          <StackPanel x:Name="SetupStage2" Visibility="Collapsed">

            <Border CornerRadius="12" Padding="15,13" Background="#1457F287" BorderThickness="1"
                    BorderBrush="#3357F287">
              <Grid>
                <Grid.ColumnDefinitions>
                  <ColumnDefinition Width="Auto"/>
                  <ColumnDefinition Width="*"/>
                </Grid.ColumnDefinitions>
                <Path Grid.Column="0" Width="13" Height="11" Stretch="Uniform"
                      Data="M0,4.5 L4,8.5 L11,0.5" Stroke="#57F287" StrokeThickness="2.2"
                      StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"
                      VerticalAlignment="Center"/>
                <StackPanel Grid.Column="1" Margin="12,0,0,0">
                  <TextBlock x:Name="SetupBotName" Foreground="#F5F4F8" FontSize="13.5"
                             FontWeight="SemiBold" TextWrapping="Wrap"/>
                  <TextBlock Foreground="#8C899D" FontSize="11.5" Margin="0,2,0,0"
                             TextWrapping="Wrap"
                             Text="Jeton vérifié auprès de Discord et enregistré dans .env."/>
                </StackPanel>
              </Grid>
            </Border>

            <TextBlock Foreground="#8C899D" FontSize="12.5" Margin="2,15,0,0" TextWrapping="Wrap"
                       Text="Reste à l'inviter sur votre serveur. Les permissions dont il a besoin sont déjà cochées ; le bot démarre pendant ce temps."/>

            <Button x:Name="InviteButton" Style="{StaticResource PrimaryButton}"
                    Margin="0,15,0,0" HorizontalAlignment="Stretch"
                    Content="Inviter le bot sur mon serveur"/>

            <Button x:Name="SkipInviteButton" Style="{StaticResource SecondaryButton}"
                    Margin="0,8,0,0" HorizontalAlignment="Stretch"
                    Content="Plus tard"/>
          </StackPanel>

        </StackPanel>

        <!-- Pied : n'apparaît qu'en cas d'échec, d'attente anormale, ou quand
             le bot tourne déjà -->
        <StackPanel x:Name="Footer" Visibility="Collapsed">
          <Border x:Name="DetailBox" CornerRadius="10" Padding="14,11" Margin="0,6,0,0"
                  Background="#0DFFFFFF" BorderBrush="#1AFFFFFF" BorderThickness="1"
                  Visibility="Collapsed" MaxHeight="150">
            <ScrollViewer VerticalScrollBarVisibility="Auto">
              <TextBlock x:Name="Detail" Foreground="#8C899D" FontSize="11"
                         FontFamily="Cascadia Mono, Consolas" TextWrapping="Wrap"/>
            </ScrollViewer>
          </Border>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,16,0,0">
            <Button x:Name="ActionButton" Style="{StaticResource SecondaryButton}"
                    Visibility="Collapsed"/>
            <Button x:Name="DismissButton" Style="{StaticResource PrimaryButton}"
                    Margin="10,0,0,0" Content="Fermer" IsDefault="True"/>
          </StackPanel>
        </StackPanel>

      </StackPanel>
    </Grid>
  </Border>
</Window>
'@

<#
    Une ligne d'étape. Le fragment est relu par XamlReader pour chaque étape :
    cela évite d'écrire six fois le même bloc dans la fenêtre, et de construire
    l'arbre visuel à la main depuis PowerShell. XamlReader ouvre une portée de
    noms sur l'élément rendu, d'où le FindName sur la ligne elle-même.
#>
$StepRowXaml = @'
<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Margin="0,0,0,11">
  <Grid.ColumnDefinitions>
    <ColumnDefinition Width="20"/>
    <ColumnDefinition Width="*"/>
  </Grid.ColumnDefinitions>

  <Grid Grid.Column="0" Width="18" Height="18" VerticalAlignment="Center">
    <Ellipse x:Name="Dot" Width="7" Height="7" Fill="#33FFFFFF"/>
    <Path x:Name="Spin" Visibility="Collapsed" Width="18" Height="18" Stretch="None"
          Data="M 9,2 A 7,7 0 0 1 16,9" Stroke="#7A85FF" StrokeThickness="2"
          StrokeStartLineCap="Round" StrokeEndLineCap="Round"
          RenderTransformOrigin="0.5,0.5">
      <Path.RenderTransform>
        <RotateTransform x:Name="SpinAngle"/>
      </Path.RenderTransform>
    </Path>
    <Path x:Name="Check" Visibility="Collapsed" Width="11" Height="9" Stretch="Uniform"
          Data="M0,4.5 L4,8.5 L11,0.5" Stroke="#57F287" StrokeThickness="2"
          StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"
          HorizontalAlignment="Center" VerticalAlignment="Center"/>
    <Path x:Name="Cross" Visibility="Collapsed" Width="9" Height="9" Stretch="Uniform"
          Data="M0,0 L9,9 M9,0 L0,9" Stroke="#ED4245" StrokeThickness="1.9"
          StrokeStartLineCap="Round" StrokeEndLineCap="Round"
          HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Grid>

  <TextBlock x:Name="Caption" Grid.Column="1" Margin="11,0,0,0" VerticalAlignment="Center"
             FontSize="13" Foreground="#6F6C80" TextWrapping="Wrap"/>
</Grid>
'@

<#
    Une carte d'action. Même procédé que pour les lignes d'étape : un fragment
    relu par XamlReader, un nom de glyphe choisi à la construction.
#>
$ActionCardXaml = @'
<Border xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Grid Margin="15,11">
    <Grid.ColumnDefinitions>
      <ColumnDefinition Width="Auto"/>
      <ColumnDefinition Width="*"/>
    </Grid.ColumnDefinitions>

    <Border x:Name="Badge" Grid.Column="0" Width="34" Height="34" CornerRadius="10"
            Background="#12FFFFFF" VerticalAlignment="Center">
      <Path x:Name="Glyph" Width="17" Height="17" Stretch="Uniform" Stroke="#A5AEFF"
            StrokeThickness="1.6" StrokeLineJoin="Round"
            StrokeStartLineCap="Round" StrokeEndLineCap="Round"
            HorizontalAlignment="Center" VerticalAlignment="Center"/>
    </Border>

    <StackPanel Grid.Column="1" VerticalAlignment="Center" Margin="14,0,0,0">
      <TextBlock x:Name="CardTitle" Foreground="#F5F4F8" FontSize="13.5" FontWeight="SemiBold"/>
      <TextBlock x:Name="CardDetail" Foreground="#8C899D" FontSize="11.5" Margin="0,2,0,0"
                 TextWrapping="Wrap"/>
    </StackPanel>
  </Grid>
</Border>
'@

# Glyphes des cartes, dessinés dans un repère de 22 × 22.
$Glyphs = @{
    # Écran posé sur son pied
    dashboard = 'M1,3 L19,3 A2,2 0 0 1 21,5 L21,14 A2,2 0 0 1 19,16 L1,16 A2,2 0 0 1 -1,14 L-1,5 A2,2 0 0 1 1,3 Z M7,20 L13,20 M10,16 L10,20'
    # Flèche circulaire, ouverte en haut à droite
    restart   = 'M18,11 A8,8 0 1 1 12.5,3.4 M18.4,2.5 L18.4,8.2 L12.7,8.2'
    # Symbole de mise hors tension
    shutdown  = 'M10,2 L10,10 M4.6,5.2 A7.5,7.5 0 1 0 15.4,5.2'
}

function LoadXaml {
    param([string]$Markup)
    $reader = New-Object System.Xml.XmlNodeReader ([xml]$Markup)
    return [Windows.Markup.XamlReader]::Load($reader)
}

function NewBrush {
    # La conversion de ColorConverter rend un objet : sans le transtypage, le
    # constructeur de SolidColorBrush ne trouve pas de surcharge applicable.
    param([string]$Value)
    return New-Object System.Windows.Media.SolidColorBrush(
        [System.Windows.Media.Color]([System.Windows.Media.ColorConverter]::ConvertFromString($Value)))
}

$window = LoadXaml $LaunchXaml

function Element([string]$Name) { return $window.FindName($Name) }

$headline     = Element 'Headline'
$header       = Element 'Header'
$surface      = Element 'Surface'
$surfaceSlide = Element 'SurfaceSlide'
$barSlide     = Element 'BarSlide'
$trackBar     = Element 'Track'
$stepList     = Element 'StepList'
$cardList     = Element 'CardList'
$footer       = Element 'Footer'
$detailBox    = Element 'DetailBox'
$detailText   = Element 'Detail'
$actionButton = Element 'ActionButton'
$dismissButton = Element 'DismissButton'
$closeButton  = Element 'CloseButton'

$setupPanel      = Element 'SetupPanel'
$setupStage1     = Element 'SetupStage1'
$setupStage2     = Element 'SetupStage2'
$portalButton    = Element 'PortalButton'
$tokenBox        = Element 'TokenBox'
$tokenHint       = Element 'TokenHint'
$setupStatus     = Element 'SetupStatus'
$setupBotName    = Element 'SetupBotName'
$inviteButton    = Element 'InviteButton'
$skipInviteButton = Element 'SkipInviteButton'

# L'icône de la fenêtre reste celle du fichier quand il existe : elle sert au
# basculement Alt+Tab, que le logo vectoriel de l'en-tête ne couvre pas.
if (Test-Path -LiteralPath $IconPath) {
    try {
        $image = New-Object System.Windows.Media.Imaging.BitmapImage
        $image.BeginInit()
        $image.UriSource = New-Object System.Uri($IconPath)
        $image.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $image.EndInit()
        $window.Icon = $image
    } catch { }
}

# --- Lignes d'étape ----------------------------------------------------------

function AddStepRow {
    param([string]$Caption)

    $row = LoadXaml $StepRowXaml
    $row.FindName('Caption').Text = $Caption
    [void]$stepList.Children.Add($row)

    return @{
        Dot     = $row.FindName('Dot')
        Spin    = $row.FindName('Spin')
        Angle   = $row.FindName('SpinAngle')
        Check   = $row.FindName('Check')
        Cross   = $row.FindName('Cross')
        Caption = $row.FindName('Caption')
    }
}

function AddActionCard {
    <#
        Ajoute une carte cliquable sous la liste des étapes. Le bloc passé en
        -OnClick est appelé sans argument ; il reçoit la carte par $script:, pas
        par fermeture, pour la raison de portée exposée plus bas.
    #>
    param(
        [string]$Title,
        [string]$Detail,
        [string]$Glyph,
        [string]$Accent = '#A5AEFF',
        [scriptblock]$OnClick
    )

    $card = LoadXaml $ActionCardXaml
    $card.Style = $window.FindResource('ActionCard')
    $card.FindName('CardTitle').Text = $Title
    $card.FindName('CardDetail').Text = $Detail
    $glyphPath = $card.FindName('Glyph')
    $glyphPath.Data = [System.Windows.Media.Geometry]::Parse($Glyphs[$Glyph])
    $glyphPath.Stroke = NewBrush $Accent

    # Le gestionnaire lit la clé dans Tag plutôt que par fermeture : un
    # scriptblock invoqué par « & » s'exécute dans la portée de l'appelant.
    $key = [string]$script:CardActions.Count
    $card.Tag = $key
    $script:CardActions[$key] = $OnClick
    $card.Add_MouseLeftButtonUp({
        param($element, $routed)
        $action = $script:CardActions[[string]$element.Tag]
        if ($action) { & $action }
    })

    [void]$cardList.Children.Add($card)
    return @{
        Root   = $card
        Title  = $card.FindName('CardTitle')
        Detail = $card.FindName('CardDetail')
        Glyph  = $glyphPath
    }
}

function SetRowState {
    <#
        États d'une ligne : pending, running, done, warned, failed. Un seul
        marqueur est visible à la fois, et la couleur du libellé suit — l'étape
        en cours doit se distinguer au premier coup d'œil.
    #>
    param($Row, [string]$State)

    $Row.Dot.Visibility   = 'Collapsed'
    $Row.Spin.Visibility  = 'Collapsed'
    $Row.Check.Visibility = 'Collapsed'
    $Row.Cross.Visibility = 'Collapsed'
    $Row.Angle.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)

    switch ($State) {
        'pending' {
            $Row.Dot.Visibility = 'Visible'
            $Row.Caption.Foreground = NewBrush '#6F6C80'
        }
        'running' {
            $Row.Spin.Visibility = 'Visible'
            $Row.Caption.Foreground = NewBrush '#F5F4F8'
            $turn = New-Object System.Windows.Media.Animation.DoubleAnimation
            $turn.From = 0
            $turn.To = 360
            $turn.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(850))
            $turn.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
            $Row.Angle.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $turn)
        }
        'done' {
            $Row.Check.Visibility = 'Visible'
            $Row.Check.Stroke = NewBrush '#57F287'
            $Row.Caption.Foreground = NewBrush '#B9B6C6'
        }
        'warned' {
            # Étape ratée mais non bloquante : le vert mentirait, la croix
            # alarmerait pour rien.
            $Row.Check.Visibility = 'Visible'
            $Row.Check.Stroke = NewBrush '#FAA61A'
            $Row.Caption.Foreground = NewBrush '#B9B6C6'
        }
        'failed' {
            $Row.Cross.Visibility = 'Visible'
            $Row.Caption.Foreground = NewBrush '#F5F4F8'
        }
    }
}

# ============================================================================
#  Étapes du lancement
# ============================================================================

<#
    Chaque étape est une table portant :
      Caption  libellé affiché dans la liste ;
      Start    ce qu'il faut déclencher en y entrant (facultatif) ;
      Poll     l'état de l'étape à chaque battement : 'running', 'done',
               'warned' ou 'failed' ;
      Fail     de quoi renseigner le pied de fenêtre si Poll rend 'failed'.

    Les blocs Start et Poll ne peuvent **pas** capturer les paramètres de la
    fonction qui les crée : en PowerShell, un scriptblock invoqué par « & »
    s'exécute dans la portée de l'appelant, pas dans celle de sa définition. Ils
    lisent donc leurs données dans l'étape courante, $script:Steps[$script:Index],
    et n'écrivent que dans des variables $script:.

    L'ordre place la vérification de la configuration **avant** l'installation
    des dépendances. Sans cela, sur un dossier fraîchement récupéré,
    `npm run deploy` s'exécuterait avant que le jeton Discord ne soit renseigné
    et échouerait à coup sûr ; comme il n'est rejoué que lorsque node_modules
    manque, les commandes slash ne seraient alors jamais enregistrées.
#>

$script:Node        = $null
$script:Bot         = $null
$script:Current     = $null   # processus de l'étape en cours, s'il y en a un
$script:Port        = DashboardPort
$script:Steps       = @()
$script:Index       = -1
$script:StepStarted = [DateTime]::UtcNow
$script:Outcome     = 'running'   # running | ready | stopped
$script:ExitCode    = 0
$script:FooterAction  = $null
$script:DismissAction = $null
$script:CardActions   = @{}
$script:SetupClientId = ''   # identifiant rendu par Discord, pour l'invitation

# Ce que dit et fait la fin d'une séquence. Le lancement s'efface tout seul ;
# une extinction, elle, n'a rien à ouvrir derrière elle et doit rester lisible.
$script:SuccessMessage   = "Le bot est prêt. Le tableau de bord va s'ouvrir."
$script:SuccessAutoClose = $true

# Durée minimale d'affichage d'une étape : sans elle, les vérifications
# instantanées défileraient en un battement et la liste ne ferait que clignoter.
$MinimumDwellMs = 320

function CurrentStep { return $script:Steps[$script:Index] }

function StepEnvironment {
    return @{
        Caption = 'Vérification de Node.js'
        Poll    = {
            $found = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
                     Select-Object -First 1
            if (-not $found) { return 'failed' }
            $script:Node = $found
            return 'done'
        }
        Fail    = @{
            Headline    = "Node.js est introuvable sur cette machine."
            Detail      = "Le bot a besoin de Node.js 18 ou supérieur. Installez la version LTS, puis relancez."
            ActionLabel = 'Télécharger Node.js'
            Action      = { Start-Process 'https://nodejs.org/fr/download' }
        }
    }
}

function StepConfiguration {
    return @{
        Caption = 'Vérification de la configuration'
        Poll    = {
            if (-not (Test-Path -LiteralPath $EnvFile)) {
                $example = Join-Path $ProjectRoot '.env.example'
                if (Test-Path -LiteralPath $example) {
                    Copy-Item -LiteralPath $example -Destination $EnvFile
                }
                return 'failed'
            }
            # Un .env recopié tel quel depuis l'exemple laisse le jeton à sa
            # valeur de démonstration : le bot démarrerait pour mourir aussitôt
            # sur un refus d'authentification, message autrement moins parlant.
            $token = EnvValue 'DISCORD_TOKEN'
            if (-not $token -or $token -eq 'your_bot_token_here') { return 'failed' }
            return 'done'
        }
        <#
            L'absence de configuration n'est pas une panne : au premier
            lancement, c'est l'état normal. Elle ouvre donc l'assistant plutôt
            qu'une carte d'échec, et personne n'a à ouvrir un fichier .env ni à
            savoir ce qu'est une variable d'environnement.
        #>
        OnFail  = { StartSetup }
        Fail    = @{
            Headline    = "Configuration à compléter."
            Detail      = "Renseignez DISCORD_TOKEN et DISCORD_CLIENT_ID dans le fichier .env, à la racine du projet, puis relancez."
            ActionLabel = 'Ouvrir le fichier .env'
            Action      = { Start-Process notepad.exe -ArgumentList "`"$EnvFile`"" }
        }
    }
}

function StepCommand {
    <#
        Étape déléguée à une commande. cmd redirige lui-même sa sortie vers le
        journal — voir la mise en garde de StartHidden.
    #>
    param([string]$Caption, [string]$Command, [string]$Log, [bool]$Required, [hashtable]$Fail)

    return @{
        Caption  = $Caption
        Command  = $Command
        Log      = $Log
        Required = $Required
        Start    = {
            $step = CurrentStep
            if (-not (Test-Path -LiteralPath $LogFolder)) {
                New-Item -ItemType Directory -Path $LogFolder -Force | Out-Null
            }
            $script:Current = StartHidden -FilePath $env:ComSpec `
                -Arguments "/c $($step.Command) 1> `"$($step.Log)`" 2>&1"
        }
        Poll     = {
            $step = CurrentStep
            if (-not $script:Current.HasExited) { return 'running' }
            if ($script:Current.ExitCode -eq 0) { return 'done' }
            if ($step.Required) { return 'failed' }
            return 'warned'
        }
        Fail     = $Fail
    }
}

function StepLaunch {
    return @{
        Caption = 'Démarrage du bot'
        Start   = {
            $script:Bot = StartHidden -FilePath $script:Node.Source -Arguments 'src/index.js'
        }
        Poll    = {
            # Un jeton invalide, un port occupé, un module cassé : le processus
            # meurt en quelques secondes. Sans console, cet échec passerait
            # inaperçu — d'où cette surveillance, qui reprend le rôle que tenait
            # le terminal resté ouvert.
            if ($script:Bot.HasExited) { return 'failed' }
            # L'étape est tenue pour franchie dès que le processus a survécu à
            # ses premières secondes ; l'attente du tableau de bord prend le
            # relais et couvre la suite du démarrage.
            if (([DateTime]::UtcNow - $script:StepStarted).TotalMilliseconds -ge 2500) { return 'done' }
            return 'running'
        }
        <#
            Un jeton refusé est le seul échec de démarrage qui ait une
            réparation évidente, et c'est aussi le plus probable sur une
            première installation — un jeton régénéré depuis, ou copié à
            moitié. Le proposer en bouton principal vaut mieux que de renvoyer
            vers un dossier de journaux où « TokenInvalid » ne dit rien à qui
            n'a jamais vu ce mot.

            Le motif se lit dans le journal parce que src/index.js y écrit
            désormais ce qui le tue, y compris ce qu'aucun try/catch n'attendait.
        #>
        OnFail  = {
            $tail = TailOf $LatestLog 20
            if ($tail -match 'TokenInvalid|An invalid token was provided') {
                ShowFooter -Message "Discord a refusé le jeton du bot." `
                    -Details "Le jeton enregistré dans .env n'est plus accepté. Il a pu être régénéré depuis sur le portail, ou n'avoir été copié qu'en partie." `
                    -ActionLabel 'Ouvrir les journaux' `
                    -Action { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" } `
                    -DismissLabel 'Reconfigurer' -DismissAction { StartSetup }
                return
            }
            FailWith (CurrentStep).Fail
        }
        Fail    = @{
            Headline    = "Le bot s'est arrêté aussitôt après son démarrage."
            Detail      = $null   # à défaut : la fin de data/logs/latest.log
            ActionLabel = 'Ouvrir les journaux'
            Action      = { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }
        }
    }
}

function StepDashboard {
    return @{
        Caption = 'Ouverture du tableau de bord'
        Poll    = {
            if ($script:Bot -and $script:Bot.HasExited) { return 'failed' }
            if (PortAnswers -Port $script:Port) { return 'done' }
            # La connexion à Discord puis la restauration de l'état de lecture
            # peuvent prendre un moment sur une grosse file d'attente. Au-delà,
            # mieux vaut rendre la main que laisser la fenêtre tourner sans fin.
            if (([DateTime]::UtcNow - $script:StepStarted).TotalSeconds -ge 90) { return 'failed' }
            return 'running'
        }
        Fail    = @{
            Headline    = "Le bot ne répond pas encore."
            Detail      = $null
            ActionLabel = 'Ouvrir les journaux'
            Action      = { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }
        }
    }
}

function BuildSteps {
    $steps = @()
    $steps += StepEnvironment
    $steps += StepConfiguration

    # Installation et enregistrement des commandes : à la première utilisation
    # seulement. L'échec du déploiement n'est pas bloquant — il se rattrape au
    # prochain lancement — là où des dépendances manquantes empêchent tout.
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
        $steps += StepCommand -Caption 'Installation des dépendances' `
            -Command 'npm install' -Log (Join-Path $LogFolder 'npm-install.log') -Required $true `
            -Fail @{
                Headline    = "L'installation des dépendances a échoué."
                Detail      = $null
                ActionLabel = 'Ouvrir les journaux'
                Action      = { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }
            }
        # Deux journaux distincts : deux redirections vers le même fichier se
        # disputeraient un verrou encore tenu par l'étape précédente.
        $steps += StepCommand -Caption 'Enregistrement des commandes Discord' `
            -Command 'npm run deploy' -Log (Join-Path $LogFolder 'npm-deploy.log') -Required $false `
            -Fail $null
    }

    $steps += StepLaunch
    $steps += StepDashboard
    return $steps
}

# ============================================================================
#  Déroulement
# ============================================================================

function ShowFooter {
    <#
        Affiche le pied de fenêtre. -DismissLabel et -DismissAction permettent
        de détourner le bouton principal le temps d'une confirmation ; sans eux
        il redevient « Fermer » et referme la fenêtre.
    #>
    param(
        [string]$Message,
        [string]$Details,
        [string]$ActionLabel,
        [scriptblock]$Action,
        [string]$DismissLabel = 'Fermer',
        [scriptblock]$DismissAction = $null
    )

    $headline.Text = $Message

    # La barre n'a plus rien à annoncer une fois le déroulement interrompu.
    $barSlide.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
    $trackBar.Visibility = 'Collapsed'

    if ($Details) {
        $detailText.Text = $Details
        $detailBox.Visibility = 'Visible'
    } else {
        $detailBox.Visibility = 'Collapsed'
    }

    if ($ActionLabel -and $Action) {
        $actionButton.Content = $ActionLabel
        $actionButton.Visibility = 'Visible'
        $script:FooterAction = $Action
    } else {
        $actionButton.Visibility = 'Collapsed'
        $script:FooterAction = $null
    }

    $dismissButton.Content = $DismissLabel
    $script:DismissAction = $DismissAction

    $footer.Visibility = 'Visible'
    [void]$dismissButton.Focus()
}

function HideFooter {
    $footer.Visibility = 'Collapsed'
    $detailBox.Visibility = 'Collapsed'
    $actionButton.Visibility = 'Collapsed'
    $script:FooterAction = $null
    $script:DismissAction = $null
    $dismissButton.Content = 'Fermer'
}

function FailWith {
    param([hashtable]$Fail)

    $message = 'Le démarrage a échoué.'
    $details = $null
    $label   = 'Ouvrir les journaux'
    $action  = { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }

    if ($Fail) {
        $message = $Fail.Headline
        $details = $Fail.Detail
        $label   = $Fail.ActionLabel
        $action  = $Fail.Action
    }
    # Les étapes qui ne portent pas d'explication propre laissent parler le
    # journal du bot : c'est là que se trouve le motif réel.
    if (-not $details) { $details = TailOf $LatestLog }
    if (-not $details) { $details = 'Aucun détail disponible dans les journaux.' }

    ShowFooter -Message $message -Details $details -ActionLabel $label -Action $action
}

function EnterStep {
    param([int]$At)

    $script:Index = $At
    $step = CurrentStep
    SetRowState $step.Row 'running'
    $script:StepStarted = [DateTime]::UtcNow
    if ($step.Start) { & $step.Start }
}

function FinishStep {
    <#
        Clôt l'étape courante puis entre dans la suivante. Rend $false quand le
        déroulement s'arrête — échec, ou dernière étape franchie. Les étapes non
        atteintes restent au repos plutôt que d'afficher une attente qui n'aura
        jamais lieu.
    #>
    param([string]$State)

    $step = CurrentStep
    SetRowState $step.Row $State

    if ($State -eq 'failed') {
        $script:Outcome = 'stopped'
        $script:ExitCode = 1
        # Une étape peut préférer conduire quelque part plutôt que d'afficher un
        # motif : c'est le cas de la configuration, dont l'échec au premier
        # lancement n'est pas un échec mais un début. Le code de sortie qu'on
        # vient de poser sera remis à zéro par StartSequence si la suite reprend.
        if ($step.OnFail) { & $step.OnFail } else { FailWith $step.Fail }
        return $false
    }

    if ($script:Index + 1 -ge $script:Steps.Count) {
        $script:Outcome = 'ready'
        return $false
    }

    EnterStep ($script:Index + 1)
    return $true
}

function FinishWithSuccess {
    <#
        Fin heureuse d'une séquence. Après un lancement ou un redémarrage la
        fenêtre s'efface — le navigateur est ouvert par le bot lui-même (voir
        WebServer.start), jamais ici. Après une extinction il n'y a rien
        derrière : la fenêtre reste, et le dit.
    #>
    $headline.Text = $script:SuccessMessage
    $barSlide.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
    $trackBar.Visibility = 'Collapsed'

    if (-not $script:SuccessAutoClose) {
        ShowFooter -Message $script:SuccessMessage
        return
    }

    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.To = 0
    $fade.BeginTime = [TimeSpan]::FromMilliseconds(1100)
    $fade.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(260))
    $fade.Add_Completed({ $window.Close() })
    $surface.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(120)
$timer.Add_Tick({
    # Sans ce filet, la moindre erreur ici laisserait la fenêtre ouverte pour
    # toujours : l'exception se perdrait dans la boucle de messages.
    try {
        if ($script:Outcome -ne 'running') { return }

        $state = & (CurrentStep).Poll
        if ($state -eq 'running') { return }

        # Une étape instantanée reste tout de même lisible un court moment.
        if (([DateTime]::UtcNow - $script:StepStarted).TotalMilliseconds -lt $MinimumDwellMs) { return }

        if (-not (FinishStep $state)) {
            $timer.Stop()
            if ($script:Outcome -eq 'ready') { FinishWithSuccess }
        }
    } catch {
        $timer.Stop()
        $script:Outcome = 'stopped'
        $script:ExitCode = 1
        ShowFooter -Message 'Le démarrage a échoué.' -Details $_.Exception.Message `
            -ActionLabel 'Ouvrir les journaux' `
            -Action { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }
    }
})

# --- Boutons et fenêtre ------------------------------------------------------

$actionButton.Add_Click({
    if ($script:FooterAction) { & $script:FooterAction }
})

# Fermer n'arrête pas le bot : le processus est indépendant de ce script, et la
# fenêtre n'accompagne que le lancement. Le bouton peut être détourné le temps
# d'une confirmation, d'où ce relais.
$dismissButton.Add_Click({
    if ($script:DismissAction) { & $script:DismissAction } else { $window.Close() }
})
$closeButton.Add_Click({ $window.Close() })

$window.Add_KeyDown({
    param($element, $routed)
    if ($routed.Key -eq [System.Windows.Input.Key]::Escape) { $window.Close() }
})

# Pas de barre de titre : l'en-tête sert de poignée. Surtout pas la fenêtre
# entière — DragMove capture la souris jusqu'au relâchement du bouton, ce qui
# escamoterait le MouseLeftButtonUp par lequel les cartes d'action sont
# activées. Les boutons, eux, marquent l'événement comme traité et ne
# remontent pas jusqu'ici.
$header.Add_MouseLeftButtonDown({
    try { $window.DragMove() } catch { }
})

# La hauteur dépend du nombre d'étapes et de l'apparition du pied : on recentre
# à chaque changement, sinon la fenêtre resterait placée d'après une taille
# provisoire et descendrait peu à peu vers le bas de l'écran.
$window.Add_SizeChanged({
    $area = [System.Windows.SystemParameters]::WorkArea
    $window.Left = $area.Left + ($area.Width  - $window.ActualWidth)  / 2
    $window.Top  = $area.Top  + ($area.Height - $window.ActualHeight) / 2
})

# ============================================================================
#  Bot déjà lancé : ouvrir, redémarrer, éteindre
# ============================================================================

function StartBarAnimation {
    # Va-et-vient perpétuel : la durée exacte d'un démarrage est inconnue.
    $trackBar.Visibility = 'Visible'
    $slide = New-Object System.Windows.Media.Animation.DoubleAnimation
    $slide.From = -120
    $slide.To = 396
    $slide.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(1500))
    $slide.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
    $sine = New-Object System.Windows.Media.Animation.SineEase
    $sine.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseInOut
    $slide.EasingFunction = $sine
    $barSlide.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $slide)
}

function StartSequence {
    <#
        Rejoue le moteur d'étapes sur une nouvelle liste : c'est ainsi qu'une
        extinction ou un redémarrage rendent compte d'eux-mêmes, avec les mêmes
        lignes, les mêmes marqueurs et le même pied que le lancement.
    #>
    param(
        [array]$Steps,
        [string]$Message,
        [string]$SuccessMessage,
        [bool]$AutoClose
    )

    $cardList.Children.Clear()
    $stepList.Children.Clear()
    $script:CardActions = @{}
    HideFooter

    $headline.Text = $Message
    $script:SuccessMessage   = $SuccessMessage
    $script:SuccessAutoClose = $AutoClose
    $script:Outcome  = 'running'
    $script:ExitCode = 0
    $script:Steps = $Steps
    foreach ($step in $script:Steps) {
        $step.Row = AddStepRow $step.Caption
        SetRowState $step.Row 'pending'
    }

    StartBarAnimation
    EnterStep 0
    $timer.Start()
}

function StepWaitPortClosed {
    param([string]$Caption, [int]$TimeoutSec, [string]$OnTimeout)

    return @{
        Caption   = $Caption
        Timeout   = $TimeoutSec
        OnTimeout = $OnTimeout
        Poll      = {
            $step = CurrentStep
            if (-not (PortAnswers -Port $script:Port)) { return 'done' }
            if (([DateTime]::UtcNow - $script:StepStarted).TotalSeconds -ge $step.Timeout) {
                return $step.OnTimeout
            }
            return 'running'
        }
        Fail      = @{
            Headline    = "Le bot n'a pas répondu à la demande."
            Detail      = $null
            ActionLabel = 'Ouvrir les journaux'
            Action      = { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }
        }
    }
}

function StepWaitPortOpen {
    param([string]$Caption, [int]$TimeoutSec)

    return @{
        Caption = $Caption
        Timeout = $TimeoutSec
        Poll    = {
            $step = CurrentStep
            if (PortAnswers -Port $script:Port) { return 'done' }
            if (([DateTime]::UtcNow - $script:StepStarted).TotalSeconds -ge $step.Timeout) {
                return 'failed'
            }
            return 'running'
        }
        Fail    = @{
            Headline    = "Le bot n'est pas revenu."
            Detail      = $null
            ActionLabel = 'Ouvrir les journaux'
            Action      = { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }
        }
    }
}

function RunRestart {
    if (-not (SendBotCommand 'restartBot')) {
        ShowFooter -Message "La demande de redémarrage n'a pas pu être transmise." `
            -Details "Le tableau de bord n'a pas répondu sur le port $($script:Port)." `
            -ActionLabel 'Ouvrir les journaux' `
            -Action { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }
        return
    }

    <#
        Le bot ferme son serveur, relance un processus, puis sort : le port
        disparaît quelques secondes avant de revenir. Ne pas l'avoir vu tomber
        n'est pas une erreur — un redémarrage très bref a pu passer entre deux
        sondages —, d'où la coche ambre plutôt que la croix.
    #>
    StartSequence -Steps @(
            (StepWaitPortClosed -Caption "Arrêt de l'instance en cours" -TimeoutSec 20 -OnTimeout 'warned'),
            (StepWaitPortOpen -Caption 'Redémarrage du bot' -TimeoutSec 90)
        ) `
        -Message 'Redémarrage en cours…' `
        -SuccessMessage 'Le bot a redémarré.' -AutoClose $true
}

function RunShutdown {
    if (-not (SendBotCommand 'shutdownBot')) {
        ShowFooter -Message "La demande d'extinction n'a pas pu être transmise." `
            -Details "Le tableau de bord n'a pas répondu sur le port $($script:Port)." `
            -ActionLabel 'Ouvrir les journaux' `
            -Action { Start-Process explorer.exe -ArgumentList "`"$LogFolder`"" }
        return
    }

    # L'extinction commence par un fondu de la musique, réglable jusqu'à
    # plusieurs secondes depuis le tableau de bord : le délai est large.
    StartSequence -Steps @(
            (StepWaitPortClosed -Caption 'Extinction du bot' -TimeoutSec 60 -OnTimeout 'failed')
        ) `
        -Message 'Extinction en cours…' `
        -SuccessMessage 'Le bot est éteint.' -AutoClose $false
}

function ConfirmShutdown {
    # Deux temps, comme le tableau de bord qui passe par sa fenêtre de
    # maintenance : couper la lecture d'un serveur entier ne doit pas tenir à un
    # clic de travers. Les cartes s'effacent le temps de la question — laissées
    # visibles, elles offriraient une troisième issue à un choix binaire.
    $cardList.Visibility = 'Collapsed'
    ShowFooter -Message "Éteindre le bot ?" `
        -Details "La lecture en cours sera interrompue pour tous les auditeurs. L'état est sauvegardé et sera restauré au prochain démarrage." `
        -ActionLabel 'Éteindre' -Action { RunShutdown } `
        -DismissLabel 'Annuler' -DismissAction { HideFooter; ShowRunningChoices }
}

function OpenDashboard {
    <#
        N'ouvre un onglet que s'il n'y en a pas déjà un. Le compte est redemandé
        à chaque clic plutôt que retenu à l'ouverture de la fenêtre : l'onglet a
        pu être fermé entre-temps, et un compte périmé condamnerait le bouton.
    #>
    $card = $script:DashboardCard
    $clients = DashboardClients

    if ($clients -gt 0) {
        $card.Detail.Text = "Déjà ouvert : $clients onglet(s) connecté(s). Aucun nouvel onglet n'a été ouvert."
        return
    }
    if ($clients -lt 0) {
        $card.Detail.Text = "Impossible de savoir si un onglet est ouvert ; ouverture quand même."
    }
    Start-Process (DashboardUrl)
    if ($clients -eq 0) { $card.Detail.Text = 'Ouvert dans votre navigateur.' }
}

function ShowRunningChoices {
    $cardList.Children.Clear()
    $cardList.Visibility = 'Visible'
    $script:CardActions = @{}
    $headline.Text = "Le bot est déjà démarré."

    $clients = DashboardClients
    $detail = if ($clients -gt 0) {
        "Déjà ouvert : $clients onglet(s) connecté(s)."
    } else {
        'Dans votre navigateur'
    }

    $script:DashboardCard = AddActionCard -Title 'Ouvrir le tableau de bord' -Detail $detail `
        -Glyph 'dashboard' -OnClick { OpenDashboard }
    [void](AddActionCard -Title 'Redémarrer le bot' `
        -Detail 'La lecture reprend où elle en était' `
        -Glyph 'restart' -OnClick { RunRestart })
    [void](AddActionCard -Title 'Éteindre le bot' `
        -Detail 'Coupe la lecture et arrête le processus' `
        -Glyph 'shutdown' -Accent '#ED4245' -OnClick { ConfirmShutdown })
}

# ============================================================================
#  Assistant de première configuration
# ============================================================================

<#
    Le jeton en cours d'examen, et celui déjà examiné.

    La vérification n'est pas faite dans le gestionnaire de saisie mais un
    battement plus tard, par l'horloge : l'appel à Discord fige le fil de
    l'interface, et lancé sur-le-champ il empêcherait « Vérification… » de
    s'afficher — la fenêtre resterait figée sur l'état précédent, sans rien dire
    de ce qu'elle attend.
#>
$script:PendingToken = ''
$script:CheckedToken = ''
$script:LastClipboard = ''

function SetupStatus {
    param([string]$Text, [string]$Color = '#6F6C80')
    $setupStatus.Text = $Text
    $setupStatus.Foreground = NewBrush $Color
}

function StartSetup {
    <#
        Ouvre l'assistant, à la place de la liste des étapes.

        Le moteur d'étapes est arrêté : ce qui suit ne dépend plus d'une horloge
        mais de ce que l'utilisateur rapporte du portail. Il repartira de zéro
        par LaunchAfterSetup, sur une liste reconstruite — le fichier .env aura
        changé entre-temps, et avec lui ce que BuildSteps décide.
    #>
    $timer.Stop()
    HideFooter
    $cardList.Children.Clear()
    $stepList.Visibility = 'Collapsed'
    $barSlide.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
    $trackBar.Visibility = 'Collapsed'
    $script:Outcome = 'stopped'

    $headline.Text = 'Première configuration'
    $setupPanel.Visibility = 'Visible'
    $setupStage1.Visibility = 'Visible'
    $setupStage2.Visibility = 'Collapsed'
    $tokenBox.Text = ''
    $script:CheckedToken = ''
    $script:PendingToken = ''

    # Le presse-papiers n'est pas vidé de ce qu'il porte déjà : quelqu'un qui a
    # copié son jeton avant de lancer le bot le verra reconnu à l'ouverture,
    # sans avoir rien à refaire.
    $script:LastClipboard = ''
    $script:SetupTimer.Start()
}

function CheckToken {
    <# Soumet un jeton à Discord et rend compte du verdict dans la fenêtre. #>
    param([string]$Token)

    $verdict = ValidateBotToken $Token
    if ($verdict.Ok) {
        AcceptApplication -Token $Token -Id $verdict.Id -Name $verdict.Name
        return
    }

    if ($verdict.Reason -eq 'offline') {
        # Le jeton n'est pas mis en cause : on n'a pas pu poser la question.
        SetupStatus "Discord est injoignable pour l'instant. Vérifiez votre connexion : la vérification se refera toute seule." '#FAA61A'
        $script:CheckedToken = ''
        return
    }

    SetupStatus "Discord refuse ce jeton. Reprenez-le dans l'onglet Bot, par Reset Token puis Copy — un jeton n'est visible qu'une fois, juste après avoir été régénéré." '#ED4245'
}

function AcceptApplication {
    <#
        L'application est reconnue : on écrit .env et on passe à l'invitation.

        L'identifiant vient de Discord et non de l'utilisateur. C'est tout
        l'intérêt de passer par l'API plutôt que de demander deux valeurs : il
        n'y a rien à recopier, donc rien à confondre — et l'erreur classique,
        prendre l'identifiant du bot pour celui de l'application, ne peut plus
        se produire.
    #>
    param([string]$Token, [string]$Id, [string]$Name)

    $script:SetupTimer.Stop()

    try {
        SetEnvValues @{ DISCORD_TOKEN = $Token.Trim(); DISCORD_CLIENT_ID = $Id }
    } catch {
        SetupStatus "Le fichier .env n'a pas pu être écrit : $($_.Exception.Message)" '#ED4245'
        $script:SetupTimer.Start()
        return
    }

    $script:SetupClientId = $Id
    $setupBotName.Text = if ($Name) { "« $Name » est reconnu." } else { 'Application reconnue.' }
    # Apostrophe droite, et non typographique : PowerShell 5.1 voit dans « ’ »
    # un délimiteur de chaîne, et la ligne ne se lirait plus.
    $headline.Text = "Plus qu'une étape."
    $setupStage1.Visibility = 'Collapsed'
    $setupStage2.Visibility = 'Visible'
}

function LaunchAfterSetup {
    <#
        Referme l'assistant et enchaîne sur le démarrage ordinaire.

        Le bot est lancé sans attendre que l'invitation soit acceptée : il
        démarre très bien sans aucun serveur, et le tableau de bord sait le
        dire — c'est même la raison d'être de sa route /api/invite. Attendre
        ferait perdre à l'utilisateur le temps de l'installation des
        dépendances, précisément pendant qu'il a autre chose à faire.
    #>
    $script:SetupTimer.Stop()
    $setupPanel.Visibility = 'Collapsed'
    $stepList.Visibility = 'Visible'

    StartSequence -Steps (BuildSteps) `
        -Message 'Démarrage en cours…' `
        -SuccessMessage "Le bot est prêt. Le tableau de bord va s'ouvrir." -AutoClose $true
}

$script:SetupTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:SetupTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:SetupTimer.Add_Tick({
    try {
        # Un jeton attend d'être vérifié : la fenêtre a eu le temps d'afficher
        # qu'elle s'y met, l'appel peut la figer le temps qu'il faut.
        if ($script:PendingToken) {
            $token = $script:PendingToken
            $script:PendingToken = ''
            CheckToken $token
            return
        }

        <#
            Surveillance du presse-papiers.

            C'est ce qui retire le dernier geste inutile : le jeton vient d'être
            copié dans le navigateur, il n'y a aucune raison de demander en plus
            de cliquer dans un champ et de coller. Seul ce qui a la forme d'un
            jeton est retenu, le reste est ignoré sans être lu davantage — et
            rien n'est conservé nulle part.
        #>
        $text = ClipboardText
        if ($text -eq $script:LastClipboard) { return }
        $script:LastClipboard = $text
        if (LooksLikeBotToken $text) { $tokenBox.Text = $text.Trim() }
    } catch { }
})

$tokenBox.Add_TextChanged({
    $value = $tokenBox.Text.Trim()
    # L'indication s'efface dès qu'il y a quelque chose à lire — avant tout
    # jugement sur la forme, sinon elle resterait par-dessus une saisie en cours.
    $tokenHint.Visibility = if ($tokenBox.Text) { 'Collapsed' } else { 'Visible' }
    if (-not (LooksLikeBotToken $value)) { return }
    # Sans cette garde, revenir sur le champ après un refus relancerait l'appel
    # à chaque frappe, sur un jeton dont on sait déjà ce que Discord en pense.
    if ($value -eq $script:CheckedToken) { return }
    $script:CheckedToken = $value
    $script:PendingToken = $value
    SetupStatus 'Vérification auprès de Discord…' '#8C899D'
})

$portalButton.Add_Click({
    Start-Process $DiscordPortal
    SetupStatus "Le portail est ouvert. Copiez le jeton : il sera reconnu ici tout seul." '#8C899D'
})

$inviteButton.Add_Click({
    Start-Process (InviteUrl $script:SetupClientId)
    LaunchAfterSetup
})

$skipInviteButton.Add_Click({ LaunchAfterSetup })

# ============================================================================
#  Mise en place puis affichage
# ============================================================================

<#
    Un port déjà ouvert signifie presque toujours un bot déjà lancé. Démarrer un
    second processus le ferait mourir sur un port occupé, et l'attente du
    tableau de bord réussirait aussitôt — un faux succès. Autant le dire, et
    offrir sur place ce qu'on peut vouloir en faire.
#>
$script:AlreadyRunning = (-not $SelfTest) -and (PortAnswers -Port $script:Port)

if ($script:AlreadyRunning) {
    $row = AddStepRow 'Le bot tourne déjà'
    SetRowState $row 'done'
} else {
    $script:Steps = BuildSteps
    foreach ($step in $script:Steps) {
        $step.Row = AddStepRow $step.Caption
        SetRowState $step.Row 'pending'
    }
}

$window.Add_Loaded({
    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.To = 1
    $fade.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(240))
    $surface.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)

    $rise = New-Object System.Windows.Media.Animation.DoubleAnimation
    $rise.To = 0
    $rise.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(380))
    $ease = New-Object System.Windows.Media.Animation.CubicEase
    $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseOut
    $rise.EasingFunction = $ease
    $surfaceSlide.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $rise)

    if ($script:AlreadyRunning) {
        $script:Outcome = 'stopped'
        $barSlide.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
        $trackBar.Visibility = 'Collapsed'
        ShowRunningChoices
        return
    }

    StartBarAnimation

    # La première étape ne démarre que maintenant : lancer un processus avant que
    # la fenêtre ne soit à l'écran donnerait un lancement sans retour visible.
    EnterStep 0
    $timer.Start()
})

if ($SelfTest) {
    <#
        Auto-test : tout est construit et câblé, on s'arrête avant l'affichage
        et avant qu'aucun processus n'ait été démarré.

        Les vérifications qui suivent ne remplacent pas un essai à l'écran, mais
        elles couvrent ce qui se casse en silence : un nom disparu du XAML rend
        $null par FindName et ne se verrait qu'au moment d'ouvrir l'assistant,
        et une permission mal décalée donnerait une invitation acceptée dont le
        bot ne pourrait ni entrer dans un salon ni y parler.
    #>
    Write-Output "Interface construite sans erreur. Étapes : $($script:Steps.Count)"
    foreach ($step in $script:Steps) { Write-Output "  - $($step.Caption)" }

    $missing = @()
    $wanted = @('SetupPanel', 'SetupStage1', 'SetupStage2', 'PortalButton',
                'TokenBox', 'TokenHint', 'SetupStatus', 'SetupBotName',
                'InviteButton', 'SkipInviteButton')
    foreach ($name in $wanted) {
        if ($null -eq (Element $name)) { $missing += $name }
    }
    if ($missing.Count -gt 0) {
        Write-Output "ÉCHEC — éléments introuvables dans le XAML : $($missing -join ', ')"
        exit 1
    }
    Write-Output "Assistant : les $($wanted.Count) éléments de la fenêtre répondent."

    # 19923984 = View Channels + Connect + Speak + Manage Channels + Move Members.
    if ($InvitePermissions -ne 19923984) {
        Write-Output "ÉCHEC — permissions attendues 19923984, obtenu $InvitePermissions"
        exit 1
    }
    Write-Output "Invitation : $(InviteUrl '000000000000000000')"

    # La forme d'un jeton, sur des exemples inventés : trois segments pour un
    # jeton, et le refus de ce qui n'en est pas un — dont la valeur de
    # démonstration de .env.example, qu'un collage distrait pourrait amener.
    $shapes = @(
        @{ Text = 'MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs'; Expect = $true },
        @{ Text = 'your_bot_token_here';                                          Expect = $false },
        @{ Text = 'https://discord.com/developers/applications';                   Expect = $false },
        @{ Text = '';                                                             Expect = $false }
    )
    foreach ($shape in $shapes) {
        if ((LooksLikeBotToken $shape.Text) -ne $shape.Expect) {
            Write-Output "ÉCHEC — forme du jeton mal jugée : « $($shape.Text) »"
            exit 1
        }
    }
    Write-Output 'Jeton : les quatre formes sont correctement jugées.'

    <#
        Écriture du .env, sur un fichier jetable.

        $EnvFile est détourné le temps de l'essai : la fonction le lit à
        l'appel, et le vrai fichier de l'utilisateur n'a rien à faire dans un
        auto-test.
    #>
    $realEnvFile = $EnvFile
    $EnvFile = Join-Path ([System.IO.Path]::GetTempPath()) "imp-selftest-$PID.env"
    try {
        [System.IO.File]::WriteAllLines($EnvFile, [string[]]@(
            '# Discord Bot Token',
            'DISCORD_TOKEN=your_bot_token_here',
            'DISCORD_CLIENT_ID=your_client_id_here',
            '',
            '# Port du tableau de bord',
            'PORT=3000'
        ), (New-Object System.Text.UTF8Encoding($false)))

        SetEnvValues @{ DISCORD_TOKEN = 'JETON.DE.TEST'; DISCORD_CLIENT_ID = '123'; PUBLIC_URL = 'x' }

        # Les fins de ligne sont celles de Windows : « $ » de .NET s'arrête
        # avant le \n et bute sur le \r, d'où le \s* qui l'absorbe.
        $written = [System.IO.File]::ReadAllText($EnvFile)
        $bytes   = [System.IO.File]::ReadAllBytes($EnvFile)
        $checks = @(
            @{ Label = 'le jeton est remplacé';        Ok = $written -match '(?m)^DISCORD_TOKEN=JETON\.DE\.TEST\s*$' },
            @{ Label = "l'identifiant est remplacé";   Ok = $written -match '(?m)^DISCORD_CLIENT_ID=123\s*$' },
            @{ Label = 'la valeur d''exemple a disparu'; Ok = $written -notmatch 'your_bot_token_here' },
            @{ Label = 'les commentaires survivent';   Ok = $written -match '# Port du tableau de bord' },
            @{ Label = 'les autres variables aussi';   Ok = $written -match '(?m)^PORT=3000\s*$' },
            @{ Label = 'une variable absente est ajoutée'; Ok = $written -match '(?m)^PUBLIC_URL=x\s*$' },
            <#
                Le BOM se cherche dans les octets, jamais dans le texte lu :
                ReadAllText le retire à la lecture, et une comparaison de
                chaînes ne pourrait donc rien voir. Elle mentirait même deux
                fois — la comparaison par défaut de .NET est sensible à la
                culture, et U+FEFF y pèse zéro : « abc ».StartsWith(BOM) rend
                vrai sur un texte qui n'en porte aucun.
            #>
            @{ Label = 'aucun BOM en tête'
               Ok = -not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and
                          $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) }
        )
        foreach ($check in $checks) {
            if (-not $check.Ok) {
                Write-Output "ÉCHEC — écriture du .env : $($check.Label)"
                exit 1
            }
        }
        Write-Output "Fichier .env : les $($checks.Count) garanties d'écriture tiennent."
    } finally {
        try { Remove-Item -LiteralPath $EnvFile -Force -ErrorAction Stop } catch { }
        $EnvFile = $realEnvFile
    }

    <#
        Le chemin complet vers Discord, avec un jeton volontairement faux : TLS,
        agent utilisateur, et surtout le classement de la réponse. Un refus doit
        se lire « rejected » et non « offline », faute de quoi l'assistant
        accuserait le réseau d'un jeton erroné.

        Hors ligne, l'essai ne conclut pas plutôt qu'il n'échoue : le réseau
        n'est pas ce que cet auto-test a pour objet.
    #>
    $verdict = ValidateBotToken 'MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs'
    if ($verdict.Ok) {
        Write-Output 'ÉCHEC — Discord a accepté un jeton inventé.'
        exit 1
    }
    if ($verdict.Reason -eq 'offline') {
        Write-Output 'Discord : injoignable, vérification non concluante (sans conséquence ici).'
    } else {
        Write-Output 'Discord : un jeton invalide est bien rapporté comme refusé.'
    }

    exit 0
}

[void]$window.ShowDialog()
$timer.Stop()

exit $script:ExitCode
