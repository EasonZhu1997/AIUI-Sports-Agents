// The audio scheduler is generic; this small product-facing adapter names it
// after its cycling purpose and keeps the wearable page free of gait wording.
export {
  DEFAULT_METRONOME_BPM as DEFAULT_CADENCE_TONE_RPM,
  METRONOME_ACCENT_VOLUME as CADENCE_TONE_ACCENT_VOLUME,
  METRONOME_NORMAL_VOLUME as CADENCE_TONE_NORMAL_VOLUME,
  METRONOME_OFF as CADENCE_TONE_OFF,
  Metronome as CadenceTone,
} from './metronome.js';
