import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const pkgPath = resolve(rootDir, 'package.json');
const configPath = resolve(rootDir, 'publish.config.json');

function readConfig() {
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

function writeConfig(config) {
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function bumpVersion(version, bump) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: rootDir, encoding: 'utf-8' }).trim();
}

function isWorkingDirClean() {
  return git('status --porcelain') === '';
}

function main() {
  const target = process.argv[2];
  const args = process.argv.slice(3);
  const dryRun = args.includes('--dry-run');
  const bump = args.find(a => ['patch', 'minor', 'major'].includes(a));

  if (!target || !['internal', 'external'].includes(target)) {
    console.error('Usage:');
    console.error('  node scripts/publish.mjs <internal|external> [patch|minor|major] [--dry-run]');
    console.error('');
    console.error('Examples:');
    console.error('  node scripts/publish.mjs internal patch');
    console.error('  node scripts/publish.mjs external minor --dry-run');
    process.exit(1);
  }

  if (!isWorkingDirClean()) {
    console.error('❌ 工作区不干净，请先提交或暂存修改');
    process.exit(1);
  }

  const config = readConfig();
  const { name, registry } = config[target];
  const npmTag = config.npmTag || 'latest';
  let version = config[target].version;

  if (bump) {
    version = bumpVersion(version, bump);
  }

  const gitTagName = target === 'internal'
    ? `v${version}-internal`
    : `v${version}`;

  console.log(`\n📦 ${dryRun ? '[DRY RUN] ' : ''}${name}@${version} → ${registry}`);
  console.log(`   npm tag → ${npmTag}`);
  console.log(`   git tag → ${gitTagName}\n`);

  if (dryRun) {
    console.log('[DRY RUN] 预检完成，未做任何修改');
    return;
  }

  // 1. Update version in publish.config.json
  config[target].version = version;
  writeConfig(config);

  // 2. Replace package.json for target
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.name = name;
  pkg.version = version;
  if (target === 'external') {
    delete pkg.scripts?.['publish:internal'];
    delete pkg.scripts?.['publish:external'];
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // 3. Commit release + tag
  git('add package.json publish.config.json');
  git(`commit -m "release(${target}): ${name}@${version}"`);
  git(`tag ${gitTagName}`);
  console.log(`🏷️  Tagged ${gitTagName}`);

  // 4. npm publish
  try {
    execSync(`npm publish --registry=${registry} --tag=${npmTag}`, {
      stdio: 'inherit',
      cwd: rootDir,
    });
    console.log(`\n✅ Successfully published ${name}@${version} (tag: ${npmTag})\n`);
  } catch (err) {
    console.error(`\n❌ Publish failed:`, err.message);
    console.log('🔄 Rolling back release commit and tag...');
    git(`tag -d ${gitTagName}`);
    git('reset --hard HEAD~1');
    process.exit(1);
  }

  // 5. Push commit + tag
  git('push');
  git(`push origin ${gitTagName}`);
  console.log(`🚀 Pushed commit and tag ${gitTagName}`);
}

main();
