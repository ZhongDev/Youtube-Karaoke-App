import fs from 'node:fs';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// Vite bundles all JS, so the Vite plugin packages the app without node_modules.
// Packages kept external (vite.main.config.ts) must be copied in by hand,
// along with their runtime dependency closure: the native better-sqlite3,
// and kuromoji, whose dictionary files live beside its code.
const EXTERNAL_PACKAGES = ['better-sqlite3', 'kuromoji'];

function collectProdDeps(name: string, fromDir: string, out: Map<string, string>): void {
  if (out.has(name)) return;
  const pkgJsonPath = require.resolve(`${name}/package.json`, { paths: [fromDir] });
  const pkgDir = path.dirname(pkgJsonPath);
  out.set(name, pkgDir);
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    collectProdDeps(dep, pkgDir, out);
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // The Python alignment worker (pyproject, uv.lock, align.py) ships beside
    // the asar; its venv is created under userData at first use (uv.ts).
    extraResource: ['worker'],
  },
  rebuildConfig: {},
  hooks: {
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      const deps = new Map<string, string>();
      for (const name of EXTERNAL_PACKAGES) {
        collectProdDeps(name, __dirname, deps);
      }
      for (const [name, srcDir] of deps) {
        await fs.promises.cp(srcDir, path.join(buildPath, 'node_modules', name), {
          recursive: true,
          dereference: true,
        });
      }
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    // better-sqlite3's native binding must live outside the asar archive.
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
