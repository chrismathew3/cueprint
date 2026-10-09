# Cueprint for Mac (experimental)

A native window around the studio, built with [Vercel's Native SDK](https://github.com/vercel-labs/native). `frontend` is a symlink to `../web`.

Needs Node 24 and Zig 0.16 (the `native` CLI offers to download Zig).

```bash
npm install -g @native-sdk/cli
native dev     # native window around the Vite dev server, YouTube import included
native build   # release binary at zig-out/bin/cueprint (no YouTube import)
```
