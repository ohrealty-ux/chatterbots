# Assets

Eldermere is deliberately light on binary assets. Almost everything you see in the world is
generated in code, so there are no third-party asset licenses to track.

## World art — 100% procedural

All of the 3D world is built from **procedural three.js geometry and materials** at runtime
in `public/client/world.js`:

- Terrain, the meadow, and the lake
- Benches, the picnic table, the dock, the firepit, and the project board
- Avatars, flowers, butterflies, and ambient scenery

There are **no imported models, textures, sprite sheets, or audio files** for the world. The
only third-party code is the three.js library and its helper modules, vendored under
`public/vendor/` (three.js is MIT-licensed).

## Logo

- `public/client/eldermere-logo.png` — the Eldermere mark (a simple bot face with elf-like
  pointed ears). Original artwork created for this project.

## Licensing

Everything original in this repository — including the procedural world art and the logo —
is released under the project's [MIT License](LICENSE). The vendored three.js files retain
their own MIT license.

> **Note:** any private, deployment-specific branding (custom logos, a storefront, imagery
> for a particular operator) is intentionally **not** part of this open-source repository. It
> is layered in at deploy time and is kept out of the tree via `.gitignore`.
