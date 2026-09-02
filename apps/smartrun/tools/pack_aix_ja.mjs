// Japanese packaging reuses the proven English staging transform, then applies
// the Japanese UI localization and ja-JP provenance in the same isolated tree.
if (!process.argv.includes('--ja')) process.argv.splice(2, 0, '--ja');
await import('./pack_aix_en.mjs');
