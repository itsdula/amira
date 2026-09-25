import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Lead, Msg } from "./types";

const FORM_URL = "https://itsdula.github.io/amira/";

const AUTH = {
  url: __AMIRA_SUPABASE_URL__,
  key: __AMIRA_SUPABASE_KEY__,
};

const SELECTION_KEYS = ["vehicle", "grade", "payment", "color", "order_now", "accessories", "purchase", "rep_time", "timing"];

function selectionChips(selection: Lead["selection"]): { key: string; value: string; filled: boolean }[] {
  return SELECTION_KEYS.map((key) => {
    const raw = selection?.[key];
    const filled = raw !== null && raw !== undefined && raw !== "" && !(Array.isArray(raw) && raw.length === 0);
    const value = filled ? (Array.isArray(raw) ? raw.join(", ") : String(raw)) : "empty";
    return { key, value, filled };
  });
}

const FLOW: [string, string][] = [
  ["channel", "channel"],
  ["vehicle", "vehicle"],
  ["grade", "grade"],
  ["payment", "payment"],
  ["color", "color"],
  ["order_now", "order"],
  ["accessories", "accessories"],
  ["purchase", "chat or call"],
  ["rep_time", "call time"],
  ["close", "close"],
];

function StepGraph({ step, status }: { step: string; status: string }) {
  const steps = step === "timing"
    ? [...FLOW.slice(0, -1), ["timing", "timing"] as [string, string], FLOW[FLOW.length - 1]]
    : FLOW;
  const at = status === "hot" || status === "cold" || step === "done"
    ? steps.length - 1
    : Math.max(0, steps.findIndex(([id]) => id === step));
  return (
    <ol className="flow" aria-label="Qualification steps">
      {steps.map(([id, label], index) => (
        <li
          key={id}
          className={index < at ? "done" : index === at ? "now" : "ahead"}
          aria-current={index === at ? "step" : undefined}
        >
          <span>{index + 1}. {label}</span>
        </li>
      ))}
    </ol>
  );
}

function when(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(new Date(iso));
}

function MessageLog({ messages, watch }: { messages: Msg[]; watch: string }) {
  const logRef = useRef<HTMLDivElement>(null);
  const latestId = messages[messages.length - 1]?.id ?? "";

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [latestId, watch]);

  if (messages.length === 0) {
    return (
      <div className="log" ref={logRef}>
        <div className="empty-state">
          <h2>No messages yet</h2>
          <p>They show up here as the conversation happens.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="log" ref={logRef}>
      <ol>
        {messages.map((message) => (
          <li key={message.id} className={message.direction}>
            <p>{message.text}</p>
            <small>
              {message.direction === "system" ? "note · " : ""}
              {when(message.at)}
              {message.meta?.send_ok === false ? ` · not delivered (${String(message.meta.send_status)})` : ""}
            </small>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function App() {
  if (!AUTH.key) {
    return (
      <main className="gate">
        <p className="eyebrow">Amira</p>
        <h1>Desk</h1>
        <p className="lede">SUPABASE_SERVICE_ROLE_KEY is missing from the project .env.</p>
      </main>
    );
  }
  return <Desk />;
}

function Desk() {
  const supabase = useMemo(
    () => createClient(AUTH.url, AUTH.key, { realtime: { params: { eventsPerSecond: 10 } } }),
    [],
  );
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const loadLeads = useCallback(async (client: SupabaseClient) => {
    const { data, error: queryError } = await client
      .from("leads")
      .select("id,mobile_e164,full_name,language,gender_form,current_step,current_channel,status,selection,opted_out,updated_at,last_inbound_at")
      .order("updated_at", { ascending: false });
    if (queryError) {
      setError(queryError.message);
      return;
    }
    setError(null);
    const rows = (data ?? []) as Lead[];
    setLeads(rows);
    setSelected((current) => (current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
  }, []);

  const loadMessages = useCallback(async (client: SupabaseClient, leadId: string) => {
    const { data, error: queryError } = await client
      .from("messages")
      .select("id,lead_id,direction,text,at,channel,meta")
      .eq("lead_id", leadId)
      .order("at", { ascending: true });
    if (queryError) {
      setError(queryError.message);
      return;
    }
    setMessages((data ?? []) as Msg[]);
  }, []);

  useEffect(() => {
    void loadLeads(supabase);
  }, [supabase, loadLeads]);

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    void loadMessages(supabase, selected);
  }, [supabase, selected, loadMessages]);

  useEffect(() => {
    const channel = supabase
      .channel("desk-store")
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
        void loadLeads(supabase);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => {
        void loadLeads(supabase);
        const row = (payload.new ?? payload.old) as { lead_id?: string } | undefined;
        const leadId = row?.lead_id;
        if (!leadId) return;
        if (!selectedRef.current) setSelected(leadId);
        if (!selectedRef.current || selectedRef.current === leadId) void loadMessages(supabase, leadId);
      })
      .subscribe((next) => setStatus(next));
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, loadLeads, loadMessages]);

  const lead = leads.find((row) => row.id === selected) ?? null;
  const chips = selectionChips(lead?.selection ?? null);

  return (
    <div className="desk">
      <aside>
        <header className="brand">
          <div>
            <p className="eyebrow">Amira</p>
            <h1>Desk</h1>
          </div>
          <span className={status === "SUBSCRIBED" ? "live on" : "live"}>{status === "SUBSCRIBED" ? "live" : status}</span>
        </header>
        {error && <p className="banner">{error}</p>}
        <ul className="leads">
          {leads.length === 0 && !error && <li className="empty">No leads yet.</li>}
          {leads.map((row) => (
            <li key={row.id}>
              <button
                className={row.id === selected ? "lead on" : "lead"}
                onClick={() => setSelected(row.id)}
              >
                <strong>{row.full_name || row.mobile_e164}</strong>
                <span>{row.full_name ? row.mobile_e164 : row.status}</span>
                <em>step: {row.current_step} · {when(row.updated_at)}</em>
              </button>
            </li>
          ))}
        </ul>
        <a className="texty form-link" href={FORM_URL} target="_blank" rel="noreferrer">Open the form</a>
      </aside>
      <section className="thread">
        {!lead && !error && (
          <div className="empty-state">
            <h2>{leads.length === 0 ? "No conversations yet" : "Select a lead"}</h2>
            <p>
              {leads.length === 0
                ? "Submit the form, then the thread shows up here."
                : "Choose a lead from the list."}
            </p>
            {leads.length === 0 && (
              <a className="form-link" href={FORM_URL} target="_blank" rel="noreferrer">Open the form</a>
            )}
          </div>
        )}
        {lead && (
          <>
            <header className="who">
              <div>
                <h2>{lead.full_name || "No name yet"}</h2>
                <p>
                  mobile: {lead.mobile_e164}
                  {" · "}language: {lead.language}
                  {" · "}gender: {lead.gender_form}
                  {" · "}channel: {lead.current_channel}
                </p>
              </div>
              <div className="pills">
                <span>status: {lead.status}</span>
                <span>step: {lead.current_step}</span>
                {lead.opted_out && <span className="bad">opted out</span>}
              </div>
            </header>
            <StepGraph step={lead.current_step} status={lead.status} />
            <div className="chips">
              {chips.map((chip) => (
                <span className={chip.filled ? "chip on" : "chip off"} key={chip.key}>
                  <b>{chip.key}:</b> {chip.value}
                </span>
              ))}
            </div>
            <MessageLog messages={messages} watch={selected ?? ""} />
          </>
        )}
      </section>
    </div>
  );
}
