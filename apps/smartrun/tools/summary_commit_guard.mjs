const DEFERRED_CALLS = [
  ['queueRunForUpload', /\b(?:this\.)?queueRunForUpload\s*\(/],
  ['persistSummaryQueues', /\b(?:this\.)?persistSummaryQueues\s*\(/],
  ['stopAccel', /\b(?:this\.)?stopAccel\s*\(/],
  ['stopMetronomePlayback', /\b(?:this\.)?stopMetronomePlayback\s*\(/],
  ['clearLiveSnapshot', /\bclearLiveSnapshot\s*\(/],
  ['beginTerminalBleCleanup', /\b(?:this\.)?beginTerminalBleCleanup\s*\(/],
  ['teardownBle', /\b(?:this\.)?teardownBle\s*\(/],
  ['releaseBleResources', /\b(?:this\.)?releaseBleResources\s*\(/],
  ['setStorageSync', /\b(?:wx\.)?setStorageSync\s*\(/],
  ['removeStorageSync', /\b(?:wx\.)?removeStorageSync\s*\(/],
  ['clearStorageSync', /\b(?:wx\.)?clearStorageSync\s*\(/],
];

const FINALIZER_CALLS = [
  ['persistSummaryQueues', /\b(?:this\.)?persistSummaryQueues\s*\(\s*\)/],
  ['stopAccel', /\b(?:this\.)?stopAccel\s*\(\s*\)/],
  [
    'stopMetronomePlayback({ destroy: true })',
    /\b(?:this\.)?stopMetronomePlayback\s*\(\s*\{\s*destroy\s*:\s*true\s*\}\s*\)/,
  ],
  ['clearLiveSnapshot(wx)', /\bclearLiveSnapshot\s*\(\s*wx\s*\)/],
  [
    'beginTerminalBleCleanup',
    /\b(?:this\.)?beginTerminalBleCleanup\s*\(\s*\)/,
  ],
];

export const SUMMARY_COMMIT_DEFERRED_TOKENS = DEFERRED_CALLS.map(([label]) => label);
export const SUMMARY_FINALIZER_REQUIRED_TOKENS = FINALIZER_CALLS.map(([label]) => label);

function firstMatchIndex(text, pattern) {
  const match = pattern.exec(String(text || ''));
  return match ? match.index : -1;
}

export function auditSummaryCommitFirst(summaryBody, finalizeBody) {
  const source = String(summaryBody || '');
  const finalizer = String(finalizeBody || '');
  const firstSetDataIndex = firstMatchIndex(source, /\bthis\.setData\s*\(/);
  const prematureDeferredTokens = [];

  for (const [label, pattern] of DEFERRED_CALLS) {
    const index = firstMatchIndex(source, pattern);
    if (index >= 0 && (firstSetDataIndex < 0 || index < firstSetDataIndex)) {
      prematureDeferredTokens.push(label);
    }
  }

  const missingFinalizerTokens = FINALIZER_CALLS
    .filter(([, pattern]) => !pattern.test(finalizer))
    .map(([label]) => label);

  return {
    ok: firstSetDataIndex >= 0
      && prematureDeferredTokens.length === 0
      && missingFinalizerTokens.length === 0,
    firstSetDataIndex,
    prematureDeferredTokens,
    missingFinalizerTokens,
  };
}
