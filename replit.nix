{ pkgs }: {
	deps = [
   pkgs.pkg-config
   pkgs.librsvg
   pkgs.giflib
   pkgs.libjpeg
   pkgs.libpng
   pkgs.pango
   pkgs.cairo
   pkgs.util-linux
		pkgs.nodejs-18_x
    pkgs.nodePackages.typescript-language-server
    pkgs.yarn
    pkgs.replitPackages.jest
	];
}