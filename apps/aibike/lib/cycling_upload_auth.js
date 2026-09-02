// Backward-compatible names for the calibration uploader. Since 0.3.72 the
// uploader shares AIBike's isolated sports identity; old aismartrun keys are
// intentionally not read or migrated.
export {
  SPORTS_HERMES_BASE_URL as CYCLING_HERMES_BASE_URL,
  SPORTS_APP_ID as CYCLING_UPLOAD_APP_ID,
  SPORTS_CREDENTIAL_PATH as CYCLING_UPLOAD_CREDENTIAL_PATH,
  SPORTS_BOOTSTRAP_PATH as CYCLING_UPLOAD_BOOTSTRAP_PATH,
  SPORTS_CREDENTIAL_KEY as CYCLING_UPLOAD_CREDENTIAL_KEY,
  SPORTS_IDENTITY_KEY as CYCLING_UPLOAD_TOKEN_KEY,
  normalizeSportsBaseUrl as normalizeCyclingHermesBaseUrl,
  buildSportsCredentialRequest as buildCyclingUploadCredentialRequest,
  parseSportsCredentialResponse as parseCyclingUploadCredentialResponse,
  normalizeSportsCredential as normalizeCyclingUploadCredential,
  readSportsCredential as readCyclingUploadCredential,
  writeSportsCredential as writeCyclingUploadCredential,
  buildSportsBootstrapRequest as buildCyclingUploadBootstrapRequest,
  parseSportsBootstrapResponse as parseCyclingUploadBootstrapResponse,
  readSportsToken as readCyclingUploadToken,
  writeSportsToken as writeCyclingUploadToken,
  clearSportsToken as clearCyclingUploadToken,
  ensureSportsIdentity as ensureCyclingUploadToken,
} from './sports_identity.js';
