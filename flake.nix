{
  description = "Deckpack development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, rust-overlay, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
      ];
      pkgsFor =
        system:
        import nixpkgs {
          inherit system;
          overlays = [ rust-overlay.overlays.default ];
        };
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
          rust = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
          desktopLibraries = with pkgs; [
            gtk3
            webkitgtk_4_1
            openssl
            librsvg
            libayatana-appindicator
            libGL
          ];
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              rust
              cargo-edit
              nodejs_26
              bun
              pkg-config
              shellcheck
              nixfmt
            ];
            buildInputs = desktopLibraries;

            # Workspace tests load GTK/WebKit even without opening a window.
            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath desktopLibraries;
          };
        }
      );

      formatter = forAllSystems (system: (pkgsFor system).nixfmt);
    };
}
