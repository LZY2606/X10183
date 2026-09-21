export interface StateFrame {
  id: number;
  importId: number;
  importOrdinal: number;
  generation: number;
  channel: number;
  arbitrationId: number;
  isExtended: boolean;
  direction: string;
  hwTime: number;
  dlc: number;
  data: string;
}
export interface State {
  versions: { id: number; versionNumber: number; label: string; validFrom: number; validTo: number | null; definitionHash: string }[];
  imports: { id: number; source_name: string; frame_count: number; ordinal: number }[];
  frameCount: { n: number };
  messages: { arbitration_id: number; is_extended: number; n: number }[];
  frames: StateFrame[];
  snapshots: { id: number; title: string; frameId: number; dbcVersionId: number }[];
  counterConfigs: { id: number; messageKey: string; node: string; signalName: string; modulus: number; increment: number }[];
  crcConfigs: { id: number; messageKey: string }[];
}
