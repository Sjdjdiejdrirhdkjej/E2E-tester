{pkgs}: {
  deps = [
    pkgs.expat
    pkgs.xorg.libxshmfence
    pkgs.libgbm
    pkgs.xorg.libxcb
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.at-spi2-core
    pkgs.alsa-lib
    pkgs.cairo
    pkgs.pango
    pkgs.mesa
    pkgs.libxkbcommon
    pkgs.libdrm
    pkgs.dbus
    pkgs.cups
    pkgs.at-spi2-atk
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}
