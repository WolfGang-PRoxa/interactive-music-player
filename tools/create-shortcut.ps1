<#
    create-shortcut.ps1 — Assistant graphique de création du raccourci de lancement.

    Lancé par « Create shortcut.vbs » posé à la racine du projet. Il affiche une
    fenêtre WPF où l'utilisateur choisit l'emplacement du raccourci, puis écrit
    un .lnk qui démarre le bot par tools\start-bot.vbs — donc sans console.

    Trois principes :
      - aucune dépendance : WPF, System.Drawing et WScript.Shell sont fournis
        par Windows ; rien n'est téléchargé ni installé ;
      - aucun chemin en dur : la racine du projet est déduite de l'emplacement
        de ce fichier, le raccourci reste donc valable où que soit le dossier ;
      - rien d'irréversible : la seule écriture hors du projet est le .lnk
        demandé, et l'icône est régénérée à la volée dans tools\.

    Encodage : UTF-8 **avec BOM**. Windows PowerShell 5.1 lit sinon ce fichier
    en page de codes ANSI et tous les accents de l'interface sont corrompus.
#>

[CmdletBinding()]
param(
    # Construit l'interface sans l'afficher : sert à vérifier le XAML et le
    # câblage des événements sans ouvrir de fenêtre.
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml,
                       System.Drawing, System.Windows.Forms

# La fenêtre étant lancée sans console, une erreur non rattrapée serait
# silencieuse : ce filet la transforme en message lisible.
trap {
    $text = "L'assistant n'a pas pu démarrer.`n`n" + $_.Exception.Message
    try {
        [void][System.Windows.MessageBox]::Show($text, 'Interactive Music Player',
            [System.Windows.MessageBoxButton]::OK, [System.Windows.MessageBoxImage]::Error)
    } catch {
        Write-Error $text
    }
    exit 1
}

# --- Emplacements -----------------------------------------------------------

$ProjectRoot   = Split-Path -Parent $PSScriptRoot
$LauncherPath  = Join-Path $PSScriptRoot 'start-bot.vbs'
$IconPath      = Join-Path $PSScriptRoot 'icon.ico'
$ShortcutName  = 'Interactive Music Player.lnk'

# Le raccourci passe par l'hôte de scripts Windows plutôt que par le .vbs
# directement : wscript.exe ne crée aucune fenêtre, là où cscript.exe — que
# certaines machines associent aux .vbs — ouvrirait une console.
$ScriptHost    = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'

# ============================================================================
#  Icône — le logo du tableau de bord, dessiné puis empaqueté en .ico
# ============================================================================

<#
    Le .ico n'est pas versionné : il est redessiné à la demande à partir des
    mêmes formes que src/web/public/favicons/favicon-glassmorphism.svg, ce qui
    garantit que le raccourci porte toujours l'identité visuelle du projet.
#>

function NewRoundedPath {
    param([single]$X, [single]$Y, [single]$Width, [single]$Height, [single]$Radius)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $Width - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $Width - $d, $Y + $Height - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $Height - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function NewNotePath {
    # Double croche : deux têtes inclinées, deux hampes, deux ligatures.
    # Repère de 64 × 64, identique à celui du favicon.
    $note = New-Object System.Drawing.Drawing2D.GraphicsPath

    # Les six morceaux se chevauchent — hampe dans la tête, ligatures sur les
    # hampes. Avec le mode par défaut (Alternate, règle pair-impair), chaque
    # recouvrement s'annule et perce un trou dans la note ; Winding les fond en
    # une seule silhouette, comme le fait le SVG avec fill-rule: nonzero. Cela
    # suppose que tous les sous-tracés tournent dans le même sens : AddEllipse,
    # AddArc et les polygones ci-dessous sont tous décrits dans le sens horaire.
    $note.FillMode = [System.Drawing.Drawing2D.FillMode]::Winding

    foreach ($head in @(@(20.0, 46.0), @(44.0, 40.0))) {
        $shape = New-Object System.Drawing.Drawing2D.GraphicsPath
        $shape.AddEllipse(-6.5, -5.0, 13.0, 10.0)
        $matrix = New-Object System.Drawing.Drawing2D.Matrix
        $matrix.Translate([single]$head[0], [single]$head[1])
        $matrix.Rotate(-25.0)
        $shape.Transform($matrix)
        $note.AddPath($shape, $false)
        $matrix.Dispose(); $shape.Dispose()
    }

    $note.AddPath((NewRoundedPath 23.0 14.0 3.5 32.0 1.5), $false)
    $note.AddPath((NewRoundedPath 47.0 8.0 3.5 32.0 1.5), $false)

    $note.AddPolygon(@(
        (New-Object System.Drawing.PointF(23.0, 14.0)),
        (New-Object System.Drawing.PointF(50.5, 8.0)),
        (New-Object System.Drawing.PointF(50.5, 13.5)),
        (New-Object System.Drawing.PointF(23.0, 19.5))))
    $note.AddPolygon(@(
        (New-Object System.Drawing.PointF(23.0, 21.5)),
        (New-Object System.Drawing.PointF(50.5, 15.5)),
        (New-Object System.Drawing.PointF(50.5, 21.0)),
        (New-Object System.Drawing.PointF(23.0, 27.0))))

    return $note
}

function DrawLogo {
    param([System.Drawing.Graphics]$Graphics, [int]$Size)

    $Graphics.SmoothingMode   = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $Graphics.ScaleTransform([single]($Size / 64.0), [single]($Size / 64.0))

    # Fond ardoise en dégradé, coins arrondis.
    $background = NewRoundedPath 2.0 2.0 60.0 60.0 16.0
    $bounds = New-Object System.Drawing.RectangleF(2.0, 2.0, 60.0, 60.0)
    $backgroundBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $bounds,
        [System.Drawing.Color]::FromArgb(255, 30, 41, 59),
        [System.Drawing.Color]::FromArgb(255, 15, 23, 42),
        45.0)
    $Graphics.FillPath($backgroundBrush, $background)

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(64, 255, 255, 255), 1.5)
    $Graphics.DrawPath($pen, $background)

    # Reflet vitré sur la moitié haute.
    $gloss = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gloss.AddBezier(2.0, 18.0, 2.0, 8.0, 8.0, 2.0, 18.0, 2.0)
    $gloss.AddLine(18.0, 2.0, 46.0, 2.0)
    $gloss.AddBezier(46.0, 2.0, 56.0, 2.0, 62.0, 8.0, 62.0, 18.0)
    $gloss.AddLine(62.0, 18.0, 62.0, 27.0)
    $gloss.AddBezier(62.0, 27.0, 42.0, 35.0, 24.0, 29.0, 2.0, 18.0)
    $gloss.CloseFigure()
    $glossBrush = New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(30, 255, 255, 255))
    $Graphics.FillPath($glossBrush, $gloss)

    # Note de musique, dégradé ciel → indigo → violet.
    $note = NewNotePath
    $noteBounds = New-Object System.Drawing.RectangleF(14.0, 6.0, 40.0, 46.0)
    $noteBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $noteBounds,
        [System.Drawing.Color]::FromArgb(255, 56, 189, 248),
        [System.Drawing.Color]::FromArgb(255, 192, 132, 252),
        45.0)
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
    $blend.Colors = @(
        [System.Drawing.Color]::FromArgb(255, 56, 189, 248),
        [System.Drawing.Color]::FromArgb(255, 129, 140, 248),
        [System.Drawing.Color]::FromArgb(255, 192, 132, 252))
    $blend.Positions = @([single]0.0, [single]0.5, [single]1.0)
    $noteBrush.InterpolationColors = $blend
    $Graphics.FillPath($noteBrush, $note)

    foreach ($disposable in @($background, $backgroundBrush, $pen, $gloss, $glossBrush, $note, $noteBrush)) {
        $disposable.Dispose()
    }
}

function WriteIcon {
    <#
        Assemble un .ico multi-résolutions. Chaque image est un PNG intégré,
        format accepté par l'explorateur depuis Windows Vista, ce qui évite
        d'avoir à produire des masques DIB à la main.
    #>
    param([string]$Destination)

    $sizes  = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
    $images = @()

    foreach ($size in $sizes) {
        $bitmap = New-Object System.Drawing.Bitmap(
            $size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([System.Drawing.Color]::Transparent)
        DrawLogo -Graphics $graphics -Size $size
        $graphics.Dispose()

        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += , $stream.ToArray()
        $stream.Dispose(); $bitmap.Dispose()
    }

    $output = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($output)
    $writer.Write([uint16]0)                 # réservé
    $writer.Write([uint16]1)                 # type : icône
    $writer.Write([uint16]$images.Count)

    $offset = 6 + 16 * $images.Count
    for ($i = 0; $i -lt $images.Count; $i++) {
        $side = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$side)           # largeur (0 = 256)
        $writer.Write([byte]$side)           # hauteur
        $writer.Write([byte]0)               # palette
        $writer.Write([byte]0)               # réservé
        $writer.Write([uint16]1)             # plans
        $writer.Write([uint16]32)            # bits par pixel
        $writer.Write([uint32]$images[$i].Length)
        $writer.Write([uint32]$offset)
        $offset += $images[$i].Length
    }
    foreach ($image in $images) { $writer.Write($image) }
    $writer.Flush()

    [System.IO.File]::WriteAllBytes($Destination, $output.ToArray())
    $writer.Dispose(); $output.Dispose()
}

function EnsureIcon {
    # L'absence d'icône ne doit jamais empêcher la création du raccourci :
    # Windows retombe alors sur l'icône par défaut du fichier de commandes.
    try {
        if (-not (Test-Path -LiteralPath $IconPath)) { WriteIcon -Destination $IconPath }
        return $true
    } catch {
        return $false
    }
}

# ============================================================================
#  Sélecteur de dossier — boîte de dialogue moderne de l'explorateur
# ============================================================================

<#
    FolderBrowserDialog de WinForms affiche encore, sous .NET Framework, la
    vieille arborescence de Windows XP. On appelle donc directement IFileDialog
    en mode « sélection de dossier », qui est la boîte moderne de l'explorateur,
    avec repli sur WinForms si l'interopérabilité COM échoue.
#>

$FolderPickerSource = @'
using System;
using System.Runtime.InteropServices;

namespace MusicPlayerShortcut
{
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileDialog
    {
        // IModalWindow
        [PreserveSig] int Show(IntPtr parent);
        // IFileDialog — l'ordre des membres reproduit la table virtuelle et ne
        // doit pas être modifié, même pour les méthodes inutilisées.
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, uint fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close([MarshalAs(UnmanagedType.Error)] int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    internal class FileOpenDialog { }

    public static class FolderPicker
    {
        private const uint FOS_PICKFOLDERS     = 0x00000020;
        private const uint FOS_FORCEFILESYSTEM = 0x00000040;
        private const uint FOS_PATHMUSTEXIST   = 0x00000800;
        private const uint SIGDN_FILESYSPATH   = 0x80058000;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out object ppv);

        /// <summary>Ouvre le sélecteur ; renvoie null si l'utilisateur annule.</summary>
        public static string Pick(IntPtr owner, string title, string okLabel, string startFolder)
        {
            IFileDialog dialog = (IFileDialog)new FileOpenDialog();
            try
            {
                dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                if (!string.IsNullOrEmpty(title))   dialog.SetTitle(title);
                if (!string.IsNullOrEmpty(okLabel)) dialog.SetOkButtonLabel(okLabel);

                if (!string.IsNullOrEmpty(startFolder))
                {
                    try
                    {
                        object item;
                        SHCreateItemFromParsingName(startFolder, IntPtr.Zero,
                            new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), out item);
                        dialog.SetFolder((IShellItem)item);
                    }
                    catch { /* dossier de départ indisponible : sans importance */ }
                }

                if (dialog.Show(owner) != 0) return null;

                IShellItem result;
                dialog.GetResult(out result);
                string path;
                result.GetDisplayName(SIGDN_FILESYSPATH, out path);
                Marshal.ReleaseComObject(result);
                return path;
            }
            finally { Marshal.ReleaseComObject(dialog); }
        }
    }
}
'@

$script:ModernPicker = $false
try {
    if (-not ('MusicPlayerShortcut.FolderPicker' -as [type])) {
        Add-Type -TypeDefinition $FolderPickerSource -Language CSharp
    }
    $script:ModernPicker = $true
} catch {
    $script:ModernPicker = $false
}

function ChooseFolder {
    param([System.Windows.Window]$Owner)

    $start = [Environment]::GetFolderPath('DesktopDirectory')

    if ($script:ModernPicker) {
        try {
            $handle = (New-Object System.Windows.Interop.WindowInteropHelper($Owner)).Handle
            return [MusicPlayerShortcut.FolderPicker]::Pick(
                $handle, 'Où placer le raccourci ?', 'Choisir ce dossier', $start)
        } catch {
            $script:ModernPicker = $false   # on ne réessaiera plus
        }
    }

    $fallback = New-Object System.Windows.Forms.FolderBrowserDialog
    $fallback.Description = 'Où placer le raccourci ?'
    $fallback.ShowNewFolderButton = $true
    $fallback.SelectedPath = $start
    if ($fallback.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $fallback.SelectedPath }
    return $null
}

# ============================================================================
#  Écriture du raccourci
# ============================================================================

function CreateShortcut {
    <#
        Écrit — ou réécrit — le .lnk et renvoie son chemin complet. Le dossier
        de travail est la racine du projet : sans lui, le bot chercherait .env
        et data/ dans le dossier du raccourci.
    #>
    param([string]$Folder)

    if (-not (Test-Path -LiteralPath $Folder -PathType Container)) {
        New-Item -ItemType Directory -Path $Folder -Force | Out-Null
    }

    $path = Join-Path $Folder $ShortcutName
    $wscript = New-Object -ComObject WScript.Shell
    try {
        $link = $wscript.CreateShortcut($path)
        $link.TargetPath       = $ScriptHost
        $link.Arguments        = "`"$LauncherPath`""
        $link.WorkingDirectory = $ProjectRoot
        $link.Description      = 'Démarre le bot Discord Interactive Music Player'
        $link.WindowStyle      = 1
        if (Test-Path -LiteralPath $IconPath) { $link.IconLocation = "$IconPath,0" }
        $link.Save()
    } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($wscript)
    }
    return $path
}

# ============================================================================
#  Interface
# ============================================================================

$Xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Interactive Music Player"
        Width="660" SizeToContent="Height"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" WindowStartupLocation="Manual"
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

    <!-- Bouton principal : pavé dégradé, plein largeur de son contenu -->
    <Style x:Key="PrimaryButton" TargetType="Button">
      <Setter Property="Foreground" Value="#FFFFFF"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Height" Value="44"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Fill" CornerRadius="12" Padding="26,0"
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
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="Fill" Property="Opacity" Value="0.32"/>
                <Setter Property="Foreground" Value="#B9B6C6"/>
                <Setter Property="Cursor" Value="Arrow"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- Bouton secondaire : contour discret -->
    <Style x:Key="SecondaryButton" TargetType="Button">
      <Setter Property="Foreground" Value="#C9C6D6"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Height" Value="44"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Fill" CornerRadius="12" Padding="22,0"
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

    <!-- Croix de fermeture -->
    <Style x:Key="CloseButtonStyle" TargetType="Button">
      <Setter Property="Width" Value="34"/>
      <Setter Property="Height" Value="34"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Fill" CornerRadius="9" Background="#00FFFFFF">
              <Path Data="M0,0 L11,11 M11,0 L0,11" Stroke="#8C899D" StrokeThickness="1.5"
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

    <!-- Interrupteur à bascule -->
    <Style x:Key="ToggleSwitch" TargetType="CheckBox">
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="CheckBox">
            <StackPanel Orientation="Horizontal" Background="#00000000">
              <Border x:Name="Track" Width="44" Height="25" CornerRadius="13"
                      Background="#14FFFFFF" BorderBrush="#26FFFFFF" BorderThickness="1"
                      VerticalAlignment="Center">
                <Ellipse x:Name="Knob" Width="17" Height="17" Fill="#8C899D"
                         HorizontalAlignment="Left" Margin="3,0,0,0"/>
              </Border>
              <ContentPresenter VerticalAlignment="Center" Margin="13,0,0,0"/>
            </StackPanel>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="Track" Property="Background" Value="#5865F2"/>
                <Setter TargetName="Track" Property="BorderBrush" Value="#7A85FF"/>
                <Setter TargetName="Knob" Property="Fill" Value="#FFFFFF"/>
                <Setter TargetName="Knob" Property="HorizontalAlignment" Value="Right"/>
                <Setter TargetName="Knob" Property="Margin" Value="0,0,3,0"/>
              </Trigger>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Track" Property="BorderBrush" Value="#4DFFFFFF"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

  </Window.Resources>

  <!-- Coque : marge réservée à l'ombre portée -->
  <Border x:Name="Surface" Margin="22" CornerRadius="20" BorderThickness="1" Opacity="0">
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
      <DropShadowEffect BlurRadius="34" ShadowDepth="9" Direction="270" Opacity="0.55" Color="#000000"/>
    </Border.Effect>
    <Border.RenderTransform>
      <TranslateTransform x:Name="SurfaceSlide" Y="16"/>
    </Border.RenderTransform>

    <Grid ClipToBounds="True">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/>
        <RowDefinition Height="*"/>
      </Grid.RowDefinitions>

      <!-- Halos décoratifs -->
      <Ellipse Grid.RowSpan="2" Width="420" Height="420" Margin="0,-230,-190,0"
               HorizontalAlignment="Right" VerticalAlignment="Top" IsHitTestVisible="False">
        <Ellipse.Fill>
          <RadialGradientBrush>
            <GradientStop Offset="0" Color="#3D5865F2"/>
            <GradientStop Offset="1" Color="#005865F2"/>
          </RadialGradientBrush>
        </Ellipse.Fill>
      </Ellipse>
      <Ellipse Grid.RowSpan="2" Width="360" Height="360" Margin="-170,0,0,-200"
               HorizontalAlignment="Left" VerticalAlignment="Bottom" IsHitTestVisible="False">
        <Ellipse.Fill>
          <RadialGradientBrush>
            <GradientStop Offset="0" Color="#2EEB459E"/>
            <GradientStop Offset="1" Color="#00EB459E"/>
          </RadialGradientBrush>
        </Ellipse.Fill>
      </Ellipse>

      <!-- Barre de titre -->
      <Grid x:Name="TitleBar" Grid.Row="0" Height="46" Background="#01FFFFFF">
        <TextBlock Text="Interactive Music Player" Foreground="#6F6C80" FontSize="12"
                   VerticalAlignment="Center" Margin="24,0,0,0"/>
        <Button x:Name="CloseButton" Style="{StaticResource CloseButtonStyle}"
                HorizontalAlignment="Right" Margin="0,0,12,0"/>
      </Grid>

      <!-- ================= Panneau : choix de l'emplacement ================= -->
      <Grid x:Name="ChoicePanel" Grid.Row="1" Margin="34,2,34,26">
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto"/>
          <RowDefinition Height="*"/>
          <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>

        <!-- En-tête -->
        <StackPanel Grid.Row="0" Orientation="Horizontal" Margin="0,0,0,26">
          <Viewbox Width="52" Height="52" VerticalAlignment="Center">
            <Grid Width="64" Height="64">
              <Rectangle Width="60" Height="60" RadiusX="16" RadiusY="16" Stroke="#40FFFFFF" StrokeThickness="1.5">
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
          <StackPanel VerticalAlignment="Center" Margin="18,0,0,0">
            <TextBlock Text="Créer un raccourci" Foreground="#F5F4F8" FontSize="25" FontWeight="SemiBold"/>
            <TextBlock Text="Choisissez où poser le raccourci qui démarre le bot."
                       Foreground="#8C899D" FontSize="13.5" Margin="0,4,0,0"/>
          </StackPanel>
        </StackPanel>

        <!-- Emplacements -->
        <StackPanel Grid.Row="1">
          <TextBlock Text="EMPLACEMENT" Foreground="#6F6C80" FontSize="10.5" FontWeight="SemiBold"
                     Margin="4,0,0,11"/>

          <Border x:Name="DesktopCard" Height="74" CornerRadius="14" Margin="0,0,0,10"
                  BorderThickness="1" Cursor="Hand">
            <Grid Margin="18,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <Border Grid.Column="0" Width="42" Height="42" CornerRadius="11" Background="#12FFFFFF"
                      VerticalAlignment="Center">
                <Path Width="21" Height="21" Stretch="Uniform" Stroke="#A5AEFF" StrokeThickness="1.5"
                      StrokeLineJoin="Round" StrokeStartLineCap="Round" StrokeEndLineCap="Round"
                      Data="M2,3 L20,3 A2,2 0 0 1 22,5 L22,15 A2,2 0 0 1 20,17 L2,17 A2,2 0 0 1 0,15 L0,5 A2,2 0 0 1 2,3 Z M8,21 L14,21 M11,17 L11,21"/>
              </Border>
              <StackPanel Grid.Column="1" VerticalAlignment="Center" Margin="16,0,12,0">
                <TextBlock Text="Bureau" Foreground="#F5F4F8" FontSize="15" FontWeight="SemiBold"/>
                <TextBlock x:Name="DesktopDetail" Text="Sous la main, dès l'ouverture de session"
                           Foreground="#8C899D" FontSize="12.5" Margin="0,3,0,0"
                           TextTrimming="CharacterEllipsis"/>
              </StackPanel>
              <Grid Grid.Column="2" Width="23" Height="23" VerticalAlignment="Center">
                <Ellipse x:Name="DesktopDot" StrokeThickness="1.5"/>
                <Path x:Name="DesktopCheck" Width="11" Height="11" Stretch="Uniform" Opacity="0"
                      Data="M0,4.5 L4,8.5 L11,0.5" Stroke="#FFFFFF" StrokeThickness="2.1"
                      StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"
                      HorizontalAlignment="Center" VerticalAlignment="Center"/>
              </Grid>
            </Grid>
          </Border>

          <Border x:Name="StartMenuCard" Height="74" CornerRadius="14" Margin="0,0,0,10"
                  BorderThickness="1" Cursor="Hand">
            <Grid Margin="18,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <Border Grid.Column="0" Width="42" Height="42" CornerRadius="11" Background="#12FFFFFF"
                      VerticalAlignment="Center">
                <Path Width="19" Height="19" Stretch="Uniform" Fill="#A5AEFF"
                      Data="M0,0 L9,0 L9,9 L0,9 Z M13,0 L22,0 L22,9 L13,9 Z M0,13 L9,13 L9,22 L0,22 Z M13,13 L22,13 L22,22 L13,22 Z"/>
              </Border>
              <StackPanel Grid.Column="1" VerticalAlignment="Center" Margin="16,0,12,0">
                <TextBlock Text="Menu Démarrer" Foreground="#F5F4F8" FontSize="15" FontWeight="SemiBold"/>
                <TextBlock x:Name="StartMenuDetail" Text="Dans la liste des applications, cherchable au clavier"
                           Foreground="#8C899D" FontSize="12.5" Margin="0,3,0,0"
                           TextTrimming="CharacterEllipsis"/>
              </StackPanel>
              <Grid Grid.Column="2" Width="23" Height="23" VerticalAlignment="Center">
                <Ellipse x:Name="StartMenuDot" StrokeThickness="1.5"/>
                <Path x:Name="StartMenuCheck" Width="11" Height="11" Stretch="Uniform" Opacity="0"
                      Data="M0,4.5 L4,8.5 L11,0.5" Stroke="#FFFFFF" StrokeThickness="2.1"
                      StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"
                      HorizontalAlignment="Center" VerticalAlignment="Center"/>
              </Grid>
            </Grid>
          </Border>

          <Border x:Name="CustomCard" Height="74" CornerRadius="14" BorderThickness="1" Cursor="Hand">
            <Grid Margin="18,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <Border Grid.Column="0" Width="42" Height="42" CornerRadius="11" Background="#12FFFFFF"
                      VerticalAlignment="Center">
                <Path Width="21" Height="21" Stretch="Uniform" Stroke="#A5AEFF" StrokeThickness="1.5"
                      StrokeLineJoin="Round" StrokeStartLineCap="Round" StrokeEndLineCap="Round"
                      Data="M0,4 A2,2 0 0 1 2,2 L7.5,2 L10,5.5 L20,5.5 A2,2 0 0 1 22,7.5 L22,17 A2,2 0 0 1 20,19 L2,19 A2,2 0 0 1 0,17 Z"/>
              </Border>
              <StackPanel Grid.Column="1" VerticalAlignment="Center" Margin="16,0,12,0">
                <TextBlock Text="Autre emplacement" Foreground="#F5F4F8" FontSize="15" FontWeight="SemiBold"/>
                <TextBlock x:Name="CustomDetail" Text="Choisir un dossier précis sur cet ordinateur"
                           Foreground="#8C899D" FontSize="12.5" Margin="0,3,0,0"
                           TextTrimming="CharacterEllipsis"/>
              </StackPanel>
              <Grid Grid.Column="2" Width="23" Height="23" VerticalAlignment="Center">
                <Ellipse x:Name="CustomDot" StrokeThickness="1.5"/>
                <Path x:Name="CustomCheck" Width="11" Height="11" Stretch="Uniform" Opacity="0"
                      Data="M0,4.5 L4,8.5 L11,0.5" Stroke="#FFFFFF" StrokeThickness="2.1"
                      StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"
                      HorizontalAlignment="Center" VerticalAlignment="Center"/>
              </Grid>
            </Grid>
          </Border>

          <!-- Option -->
          <CheckBox x:Name="StartupToggle" Style="{StaticResource ToggleSwitch}" Margin="2,22,0,0">
            <StackPanel>
              <TextBlock Text="Démarrer le bot avec Windows" Foreground="#E7E5EF" FontSize="13.5"/>
              <TextBlock Text="Ajoute aussi un raccourci au dossier de démarrage"
                         Foreground="#6F6C80" FontSize="11.5" Margin="0,2,0,0"/>
            </StackPanel>
          </CheckBox>

          <!-- Avertissement conditionnel : configuration non renseignée -->
          <Border x:Name="ConfigNotice" CornerRadius="11" Padding="15,11" Margin="0,20,0,0"
                  Background="#1AEB459E" BorderBrush="#3DEB459E" BorderThickness="1"
                  Visibility="Collapsed">
            <TextBlock TextWrapping="Wrap" Foreground="#E9C7DC" FontSize="12.5"
                       Text="Le fichier .env n'existe pas encore : au premier lancement, le raccourci le créera et vous invitera à y coller votre jeton Discord."/>
          </Border>
        </StackPanel>

        <!-- Actions -->
        <StackPanel Grid.Row="2" Margin="0,24,0,0">
          <TextBlock x:Name="DestinationLabel" Foreground="#6F6C80" FontSize="12"
                     TextTrimming="CharacterEllipsis" Margin="2,0,2,14"
                     Text="Sélectionnez un emplacement pour continuer."/>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
            <Button x:Name="CancelButton" Style="{StaticResource SecondaryButton}" Content="Annuler"/>
            <Button x:Name="CreateButton" Style="{StaticResource PrimaryButton}" Margin="12,0,0,0"
                    Content="Créer le raccourci" IsEnabled="False" IsDefault="True"/>
          </StackPanel>
        </StackPanel>
      </Grid>

      <!-- ================= Panneau : résultat ================= -->
      <Grid x:Name="ResultPanel" Grid.Row="1" Margin="42,0,42,30" Visibility="Collapsed" Opacity="0">
        <Grid.RowDefinitions>
          <RowDefinition Height="*"/>
          <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>

        <StackPanel Grid.Row="0" VerticalAlignment="Center" HorizontalAlignment="Center">
          <Grid x:Name="ResultBadge" Width="96" Height="96" HorizontalAlignment="Center"
                RenderTransformOrigin="0.5,0.5">
            <Grid.RenderTransform>
              <ScaleTransform x:Name="BadgeScale" ScaleX="0.6" ScaleY="0.6"/>
            </Grid.RenderTransform>
            <Ellipse x:Name="BadgeGlow" Fill="#1F57F287"/>
            <Ellipse x:Name="BadgeRing" Stroke="#57F287" StrokeThickness="2" Margin="10"/>
            <Path x:Name="BadgeMark" Width="34" Height="34" Stretch="Uniform"
                  Data="M0,5 L4.5,9.5 L12.5,0.5" Stroke="#57F287" StrokeThickness="2.4"
                  StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"
                  HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Grid>

          <TextBlock x:Name="ResultTitle" Text="Raccourci créé" Foreground="#F5F4F8" FontSize="23"
                     FontWeight="SemiBold" HorizontalAlignment="Center" Margin="0,26,0,0"/>
          <TextBlock x:Name="ResultMessage" Foreground="#8C899D" FontSize="13.5" TextWrapping="Wrap"
                     TextAlignment="Center" MaxWidth="470" Margin="0,9,0,0"
                     Text="Double-cliquez dessus pour démarrer le bot."/>

          <Border x:Name="PathBox" CornerRadius="11" Padding="16,12" Margin="0,22,0,0"
                  Background="#0DFFFFFF" BorderBrush="#1AFFFFFF" BorderThickness="1" MaxWidth="490">
            <TextBlock x:Name="ResultPath" Foreground="#B9B6C6" FontSize="12"
                       FontFamily="Cascadia Mono, Consolas" TextWrapping="Wrap" TextAlignment="Center"/>
          </Border>
        </StackPanel>

        <StackPanel Grid.Row="1" Orientation="Horizontal" HorizontalAlignment="Center" Margin="0,26,0,0">
          <Button x:Name="OpenFolderButton" Style="{StaticResource SecondaryButton}" Content="Ouvrir le dossier"/>
          <Button x:Name="DoneButton" Style="{StaticResource PrimaryButton}" Margin="12,0,0,0"
                  Content="Terminer"/>
        </StackPanel>
      </Grid>

    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$Xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)

function Element([string]$Name) { return $window.FindName($Name) }

$surface          = Element 'Surface'
$surfaceSlide     = Element 'SurfaceSlide'
$titleBar         = Element 'TitleBar'
$closeButton      = Element 'CloseButton'
$choicePanel      = Element 'ChoicePanel'
$resultPanel      = Element 'ResultPanel'
$startupToggle    = Element 'StartupToggle'
$configNotice     = Element 'ConfigNotice'
$destinationLabel = Element 'DestinationLabel'
$cancelButton     = Element 'CancelButton'
$createButton     = Element 'CreateButton'
$openFolderButton = Element 'OpenFolderButton'
$doneButton       = Element 'DoneButton'
$badgeScale       = Element 'BadgeScale'
$badgeGlow        = Element 'BadgeGlow'
$badgeRing        = Element 'BadgeRing'
$badgeMark        = Element 'BadgeMark'
$resultTitle      = Element 'ResultTitle'
$resultMessage    = Element 'ResultMessage'
$pathBox          = Element 'PathBox'
$resultPath       = Element 'ResultPath'

# --- Petite bibliothèque d'animation ----------------------------------------

function ToColor([string]$Value) {
    return [System.Windows.Media.Color]([System.Windows.Media.ColorConverter]::ConvertFromString($Value))
}

function NewBrush([string]$Value) {
    # Un pinceau créé ici n'est jamais figé, donc toujours animable — ce que ne
    # garantit pas la conversion automatique des attributs XAML.
    return New-Object System.Windows.Media.SolidColorBrush((ToColor $Value))
}

function NewEase {
    param([string]$Mode = 'EaseOut')
    $ease = New-Object System.Windows.Media.Animation.CubicEase
    $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::$Mode
    return $ease
}

function AnimateColor {
    param($Target, [string]$To, [int]$Duration = 170)
    if ($null -eq $Target) { return }
    $animation = New-Object System.Windows.Media.Animation.ColorAnimation
    $animation.To = ToColor $To
    $animation.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds($Duration))
    $animation.EasingFunction = NewEase
    $Target.BeginAnimation([System.Windows.Media.SolidColorBrush]::ColorProperty, $animation)
}

function AnimateDouble {
    param($Target, $Property, [double]$To, [int]$Duration = 220, [int]$Delay = 0, $Ease = $null)
    if ($null -eq $Target) { return }
    $animation = New-Object System.Windows.Media.Animation.DoubleAnimation
    $animation.To = $To
    $animation.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds($Duration))
    if ($Delay -gt 0) { $animation.BeginTime = [TimeSpan]::FromMilliseconds($Delay) }
    $animation.EasingFunction = if ($Ease) { $Ease } else { NewEase }
    $Target.BeginAnimation($Property, $animation)
}

# --- Cartes d'emplacement ----------------------------------------------------

$script:Choice       = $null   # 'desktop' | 'startMenu' | 'custom'
$script:CustomFolder = $null

$cards = @{
    desktop = @{
        Border = Element 'DesktopCard'
        Dot    = Element 'DesktopDot'
        Check  = Element 'DesktopCheck'
        Detail = Element 'DesktopDetail'
        Folder = { [Environment]::GetFolderPath('DesktopDirectory') }
    }
    startMenu = @{
        Border = Element 'StartMenuCard'
        Dot    = Element 'StartMenuDot'
        Check  = Element 'StartMenuCheck'
        Detail = Element 'StartMenuDetail'
        Folder = { [Environment]::GetFolderPath('Programs') }
    }
    custom = @{
        Border = Element 'CustomCard'
        Dot    = Element 'CustomDot'
        Check  = Element 'CustomCheck'
        Detail = Element 'CustomDetail'
        Folder = { $script:CustomFolder }
    }
}

foreach ($key in @('desktop', 'startMenu', 'custom')) {
    $card = $cards[$key]
    $card.Border.Background  = NewBrush '#0DFFFFFF'
    $card.Border.BorderBrush = NewBrush '#1AFFFFFF'
    $card.Dot.Fill           = NewBrush '#005865F2'
    $card.Dot.Stroke         = NewBrush '#33FFFFFF'
    $card.Border.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
    $scale = New-Object System.Windows.Media.ScaleTransform
    $card.Border.RenderTransform = $scale
    $card.Scale = $scale
    $card.Hover = $false
}

function PaintCard {
    param([string]$Key)

    $card = $cards[$Key]
    $selected = ($script:Choice -eq $Key)

    if ($selected) {
        AnimateColor $card.Border.Background  '#265865F2'
        AnimateColor $card.Border.BorderBrush '#CC7A85FF'
        AnimateColor $card.Dot.Fill           '#FF5865F2'
        AnimateColor $card.Dot.Stroke         '#FF7A85FF'
        AnimateDouble $card.Check ([System.Windows.UIElement]::OpacityProperty) 1 180
    } else {
        $fill   = if ($card.Hover) { '#17FFFFFF' } else { '#0DFFFFFF' }
        $stroke = if ($card.Hover) { '#36FFFFFF' } else { '#1AFFFFFF' }
        AnimateColor $card.Border.Background  $fill
        AnimateColor $card.Border.BorderBrush $stroke
        AnimateColor $card.Dot.Fill           '#005865F2'
        AnimateColor $card.Dot.Stroke         $(if ($card.Hover) { '#4DFFFFFF' } else { '#33FFFFFF' })
        AnimateDouble $card.Check ([System.Windows.UIElement]::OpacityProperty) 0 140
    }

    $raised = ($card.Hover -or $selected)
    $factor = if ($raised) { 1.012 } else { 1.0 }
    AnimateDouble $card.Scale ([System.Windows.Media.ScaleTransform]::ScaleXProperty) $factor 180
    AnimateDouble $card.Scale ([System.Windows.Media.ScaleTransform]::ScaleYProperty) $factor 180
}

function ShortenPath {
    # L'ellipse de WPF ne mange que la fin : sur un chemin, c'est justement la
    # partie qui renseigne. On raccourcit donc le milieu à la main.
    param([string]$Path, [int]$Max = 78)

    if ($Path.Length -le $Max) { return $Path }
    $leaf   = Split-Path -Path $Path -Leaf
    $parent = Split-Path -Path $Path -Parent
    $room = $Max - $leaf.Length - 3
    if ($room -lt 10) { return "…\$leaf" }
    return $parent.Substring(0, $room) + "…\" + $leaf
}

function UpdateDestination {
    $folder = if ($script:Choice) { & $cards[$script:Choice].Folder } else { $null }
    if ($folder) {
        $full = Join-Path $folder $ShortcutName
        $createButton.IsEnabled = $true
        $destinationLabel.Text = ShortenPath $full
        $destinationLabel.ToolTip = $full
    } else {
        $createButton.IsEnabled = $false
        $destinationLabel.Text = 'Sélectionnez un emplacement pour continuer.'
        $destinationLabel.ToolTip = $null
    }
}

function SelectCard {
    param([string]$Key)

    if ($Key -eq 'custom') {
        $folder = ChooseFolder -Owner $window
        if (-not $folder) {
            # Annulation du sélecteur : la sélection précédente reste en place.
            PaintCard 'custom'
            return
        }
        $script:CustomFolder = $folder
        $cards.custom.Detail.Text = ShortenPath $folder 52
        $cards.custom.Detail.ToolTip = $folder
    }

    $previous = $script:Choice
    $script:Choice = $Key
    if ($previous -and $previous -ne $Key) { PaintCard $previous }
    PaintCard $Key
    UpdateDestination
}

foreach ($key in @('desktop', 'startMenu', 'custom')) {
    $card = $cards[$key]
    # La clé voyage dans Tag plutôt que dans une fermeture : les trois cartes
    # partagent ainsi les mêmes gestionnaires, qui lisent l'émetteur.
    $card.Border.Tag = $key
    # « sender » est une variable automatique de PowerShell : on nomme
    # l'émetteur autrement pour ne pas la masquer.
    $card.Border.Add_MouseEnter({
        param($element, $routed)
        $cards[$element.Tag].Hover = $true
        PaintCard $element.Tag
    })
    $card.Border.Add_MouseLeave({
        param($element, $routed)
        $cards[$element.Tag].Hover = $false
        PaintCard $element.Tag
    })
    $card.Border.Add_MouseLeftButtonUp({
        param($element, $routed)
        SelectCard $element.Tag
    })
}

# --- Bascule des panneaux ----------------------------------------------------

function ShowResult {
    param([bool]$Success, [string]$Title, [string]$Message, [string]$Path)

    $color = if ($Success) { '#57F287' } else { '#ED4245' }
    $badgeGlow.Fill  = NewBrush $(if ($Success) { '#1F57F287' } else { '#1FED4245' })
    $badgeRing.Stroke = NewBrush $color
    $badgeMark.Stroke = NewBrush $color
    $badgeMark.Data = [System.Windows.Media.Geometry]::Parse(
        $(if ($Success) { 'M0,5 L4.5,9.5 L12.5,0.5' } else { 'M0,0 L11,11 M11,0 L0,11' }))

    $resultTitle.Text = $Title
    $resultMessage.Text = $Message
    if ($Path) {
        $resultPath.Text = $Path
        $pathBox.Visibility = 'Visible'
    } else {
        $pathBox.Visibility = 'Collapsed'
    }
    $openFolderButton.Visibility = $(if ($Success) { 'Visible' } else { 'Collapsed' })

    AnimateDouble $choicePanel ([System.Windows.UIElement]::OpacityProperty) 0 130
    $choicePanel.IsHitTestVisible = $false

    $resultPanel.Visibility = 'Visible'
    AnimateDouble $resultPanel ([System.Windows.UIElement]::OpacityProperty) 1 260 120

    $bounce = New-Object System.Windows.Media.Animation.BackEase
    $bounce.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseOut
    $bounce.Amplitude = 0.7
    AnimateDouble $badgeScale ([System.Windows.Media.ScaleTransform]::ScaleXProperty) 1 420 120 $bounce
    AnimateDouble $badgeScale ([System.Windows.Media.ScaleTransform]::ScaleYProperty) 1 420 120 $bounce

    # Entrée valide désormais la fermeture, plus la création.
    $createButton.IsDefault = $false
    $doneButton.IsDefault = $true
    [void]$doneButton.Focus()
}

# --- Création ----------------------------------------------------------------

$script:CreatedPath = $null

$createButton.Add_Click({
    if (-not $script:Choice) { return }
    $createButton.IsEnabled = $false

    try {
        [void](EnsureIcon)

        $folder = & $cards[$script:Choice].Folder
        $path   = CreateShortcut -Folder $folder
        $script:CreatedPath = $path

        $message = 'Double-cliquez dessus pour démarrer le bot et ouvrir le tableau de bord.'
        if ($startupToggle.IsChecked) {
            $startupFolder = [Environment]::GetFolderPath('Startup')
            [void](CreateShortcut -Folder $startupFolder)
            $message += ' Le bot se lancera aussi à chaque ouverture de session Windows.'
        }

        ShowResult -Success $true -Title 'Raccourci créé' -Message $message -Path $path
    } catch {
        ShowResult -Success $false -Title 'Création impossible' `
            -Message $_.Exception.Message -Path $null
        $createButton.IsEnabled = $true
    }
})

$openFolderButton.Add_Click({
    if ($script:CreatedPath) {
        Start-Process explorer.exe -ArgumentList "/select,`"$($script:CreatedPath)`""
    }
})

$doneButton.Add_Click({ $window.Close() })
$cancelButton.Add_Click({ $window.Close() })
$closeButton.Add_Click({ $window.Close() })

$titleBar.Add_MouseLeftButtonDown({
    try { $window.DragMove() } catch { }
})

# Les cartes ne sont pas des contrôles focusables : le clavier passe donc par
# les chiffres 1 à 3, Entrée validant ensuite le bouton par défaut.
$window.Add_KeyDown({
    param($element, $routed)
    if ($routed.Key -eq [System.Windows.Input.Key]::Escape) { $window.Close(); return }
    # Une fois le résultat affiché, les chiffres ne doivent plus rien déclencher —
    # « 3 » rouvrirait sinon le sélecteur de dossier.
    if (-not $choicePanel.IsHitTestVisible) { return }
    switch ($routed.Key) {
        ([System.Windows.Input.Key]::D1)      { SelectCard 'desktop' }
        ([System.Windows.Input.Key]::NumPad1) { SelectCard 'desktop' }
        ([System.Windows.Input.Key]::D2)      { SelectCard 'startMenu' }
        ([System.Windows.Input.Key]::NumPad2) { SelectCard 'startMenu' }
        ([System.Windows.Input.Key]::D3)      { SelectCard 'custom' }
        ([System.Windows.Input.Key]::NumPad3) { SelectCard 'custom' }
    }
})

# --- Ouverture ---------------------------------------------------------------

$window.Add_Loaded({
    # La hauteur s'ajuste au contenu : on centre une fois celle-ci connue,
    # sinon la fenêtre serait placée d'après une taille encore provisoire.
    $area = [System.Windows.SystemParameters]::WorkArea
    $window.Left = $area.Left + ($area.Width  - $window.ActualWidth)  / 2
    $window.Top  = $area.Top  + ($area.Height - $window.ActualHeight) / 2

    AnimateDouble $surface ([System.Windows.UIElement]::OpacityProperty) 1 260
    AnimateDouble $surfaceSlide ([System.Windows.Media.TranslateTransform]::YProperty) 0 420
})

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot '.env'))) {
    $configNotice.Visibility = 'Visible'
}

try {
    if (EnsureIcon) {
        $image = New-Object System.Windows.Media.Imaging.BitmapImage
        $image.BeginInit()
        $image.UriSource = New-Object System.Uri($IconPath)
        $image.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $image.EndInit()
        $window.Icon = $image
    }
} catch { }

if ($SelfTest) {
    # Auto-test : tout est construit et câblé, on s'arrête avant l'affichage.
    Write-Output 'Interface construite sans erreur.'
    exit 0
}

[void]$window.ShowDialog()
