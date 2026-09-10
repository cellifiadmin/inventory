const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

module.exports = function purchaseCoverageConfig(root, kind) {
  const base = require(path.join(root, 'jest.config.js'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'test/purchase-coverage-manifest.json'), 'utf8'));
  const files = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['__tests__', 'node_modules'].includes(entry.name)) walk(file); }
      else if (/\.tsx?$/.test(file) && !file.endsWith('.d.ts')) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (manifest.sourcePrefixes.some(prefix => relative.startsWith(prefix))) visit(file);
      }
    }
  }
  function visit(file) {
    if (files.has(file)) return;
    files.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const imported of ts.preProcessFile(source).importedFiles) {
      const name = imported.fileName;
      const stem = name.startsWith('@/') ? path.join(root, 'src', name.slice(2))
        : name.startsWith('.') ? path.resolve(path.dirname(file), name) : null;
      if (!stem || !stem.startsWith(path.join(root, 'src') + path.sep)) continue;
      const target = [stem, `${stem}.ts`, `${stem}.tsx`, path.join(stem, 'index.ts')]
        .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile() && /\.tsx?$/.test(candidate) && !candidate.endsWith('.d.ts'));
      if (target) visit(target);
    }
  }
  walk(path.join(root, 'src'));
  if (!files.size) throw new Error('Purchase coverage manifest selected no source files');
  // Type-only modules have no executable code. Do not hide runtime index files.
  const sources = [...files].filter(file => {
    const emitted = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, removeComments: true },
    }).outputText.replace(/export\s*\{\s*\}\s*;?/g, '').replace(/^[;\s]*$/, '').trim();
    return emitted.length > 0;
  }).map(file => path.relative(root, file).split(path.sep).join('/')).sort();
  if (!sources.length) throw new Error('Purchase coverage manifest selected no executable source files');
  const thresholds = Object.fromEntries(sources.map(file => [`./${file}`, { statements: 100, branches: 100, functions: 100, lines: 100 }]));
  const suites = {
    unit: ['<rootDir>/test/unit/**/*.test.ts', '<rootDir>/src/**/__tests__/unit/**/*.test.ts'],
    integration: ['<rootDir>/test/integration/**/*.test.ts'],
    providers: ['<rootDir>/test/providers/**/*.test.ts'],
    regression: ['<rootDir>/test/regression/**/*.test.ts'],
  };
  if (!suites[kind]) throw new Error('Unsupported purchase test suite');
  return {
    ...base, rootDir: root, testMatch: suites[kind], collectCoverageFrom: sources,
    coverageDirectory: path.join(root, 'coverage', `purchase-${kind}`),
    coverageReporters: ['text-summary', 'json-summary', 'json', 'lcov'],
    ...(kind === 'unit' ? { coverageThreshold: thresholds } : {}),
    ...(kind === 'integration' ? { setupFiles: ['<rootDir>/test/helpers/purchaseTestEnvironment.cjs'] } : {}),
  };
};
