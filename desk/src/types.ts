export type Lead = {
  id: string;
  mobile_e164: string;
  full_name: string | null;
  language: string;
  gender_form: string;
  current_step: string;
  current_channel: string;
  status: string;
  selection: Record<string, unknown> | null;
  opted_out: boolean;
  updated_at: string;
  last_inbound_at: string | null;
};

export type Msg = {
  id: string;
  lead_id: string;
  direction: "in" | "out" | "system";
  text: string;
  at: string;
  channel: string;
  meta: Record<string, unknown> | null;
};
