// electron-builder afterPack hook: copy the daemon's production node_modules into <resources>/app-root.
// (electron-builder never copies node_modules through extraResources, even when listed in the filter.)
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync } = require('node:fs');
const { join, relative, resolve } = require('node:path');

exports.default = async function afterPack(context) {
  const root = resolve(__dirname, '..', '..');
  const resources = context.packager.platform.name === 'mac'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  const dest = join(resources, 'app-root');

  // Every installed runtime (non-dev) package of the root project, as absolute paths.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const out = execFileSync(npm, ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  const dirs = out.split(/\r?\n/).map(s => s.trim()).filter(p => p && p !== root && existsSync(p));
  for (const dir of dirs) cpSync(dir, join(dest, relative(root, dir)), { recursive: true });
  console.log(`  • copied ${dirs.length} runtime packages into ${relative(context.appOutDir, dest)}`);
};
