
// ══════════════════════════════════════════════════════════════════════════
// CHANGELOG — v9.3.103 (03 Sep 2026)
// Deal close flow — fixes "closing a deal does nothing / never leaves board".
//   1. Added "Close deal" control to the deal panel (DealInfoTab). Opens a
//      prompt requiring a Won/Lost choice and a free-text reason (reason is
//      mandatory — warns if blank). On confirm, sets state to closed_won /
//      closed_lost, writes close_reason, and sets archived:true so the card
//      leaves the board.
//   2. Archive button no longer silently forces state:"closed_won" — it now
//      only archives, leaving state untouched (was mislabelling every
//      archived deal as won and polluting the Won count).
//   3. Removed closed_won / closed_lost from the raw State dropdown so a
//      closed state can no longer be set without a reason (dead-control fix).
//   REQUIRES DB MIGRATION (run once in Supabase):
//      ALTER TABLE deals ADD COLUMN close_reason text;
//   Conscious v9 exception to the "no schema changes" rule (owner-approved):
//   closing without recording the reason defeats the purpose.
//   NOT in this build: Lead-panel close still lost-only and still needs its
//   archived:true fix (leads convert to deals, don't close won) — logged.
// ══════════════════════════════════════════════════════════════════════════

const VERSION = "v9.3.103";

// ── SUPABASE ──
const SB_URL = "https://ponmgyurofsthaxnrvfd.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBvbm1neXVyb2ZzdGhheG5ydmZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNjg2MTQsImV4cCI6MjA5MTk0NDYxNH0.mYMrmV3FmDkG7PHbMvdyOP63Xauar5i03qJ-7ais-t0";

const sb = {
  async select(table, query = "") {
    const qs = query ? query : "order=created_at.desc";
    const r = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
    });
    if (!r.ok) throw new Error(`SELECT ${table} failed: ${r.status}`);
    return r.json();
  },
  async insert(table, row) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(row)
    });
    if (!r.ok) throw new Error(`INSERT ${table} failed: ${r.status}`);
    return r.json();
  },
  async update(table, id, updates) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(updates)
    });
    if (!r.ok) { const txt = await r.text(); throw new Error(`UPDATE ${table} failed: ${r.status} — ${txt}`); }
    return r.json();
  },
  async delete(table, id) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "DELETE",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }
    });
    if (!r.ok) throw new Error(`DELETE ${table} failed: ${r.status}`);
    return true;
  },
  async upsert(table, row, onConflict = "id") {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify(row)
    });
    if (!r.ok) throw new Error(`UPSERT ${table} failed: ${r.status}`);
    return r.json();
  }
};

// ── UTILITIES ──
const genId = () => Math.random().toString(36).substr(2, 9);
const nowISO = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().split("T")[0];
const fmtDate = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch { return iso; } };
const fmtTime = (iso) => { if (!iso) return ""; try { return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const fmtRelDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso); const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return "Today"; if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff}d ago`; return fmtDate(iso);
};
const isOverdue = (dueDate) => { if (!dueDate) return false; return new Date(dueDate) < new Date(todayStr()); };
const isToday = (dueDate) => dueDate === todayStr();

// ── TASK LIFECYCLE → ACTIVITY TIMELINE (v9.3.96) ──
// Writes a read-only echo of a task event into the owning deal's Activity
// stream. The task itself remains a standalone object in state.tasks; the
// thread entry is a timestamped record of the event, not the task.
// entry_type distinguishes lifecycle entries ("task_created" etc.) from
// user-authored notes: it drives the icon rendering AND suppresses
// edit/delete controls. is_system_event stays false — these entries are
// first-class visible, never hidden behind the metadata toggle.
// Defensive save: if the entry_type column is missing in Supabase the
// entry is saved without it (and will render as an ordinary editable
// note) — run ALTER TABLE thread_entries ADD COLUMN IF NOT EXISTS
// entry_type text; to get correct behaviour.
const TASK_EVENT_TYPES = ["task_created", "task_completed", "task_archived", "task_doc"];
const isTaskEvent = (entry) => TASK_EVENT_TYPES.includes(entry.entry_type);
const logTaskEvent = async (dispatch, task, eventType, extra) => {
  // Floating tasks have no deal to write to
  if (!task.card_id || (task.card_type !== "deal" && task.card_type !== "lead")) return;
  let text;
  if (eventType === "task_created") text = `Task created: ${task.title}`;
  else if (eventType === "task_completed") {
    text = `Task completed: ${task.title}`;
    if (extra && extra.resolution) text += ` — Resolution: ${extra.resolution}`;
  }
  else if (eventType === "task_archived") text = `Task archived: ${task.title}`;
  else if (eventType === "task_doc") text = `Document linked via task: ${task.title}`;
  else return;
  const base = {
    id: genId(), card_id: task.card_id, card_type: "deal",
    channel: "Note", text,
    is_system_event: false, created_at: nowISO(),
  };
  if (eventType === "task_doc" && extra && extra.drive_link) {
    base.drive_link = extra.drive_link;
    base.drive_link_label = extra.drive_link_label || null;
  }
  try {
    try {
      const full = { ...base, entry_type: eventType };
      await sb.insert("thread_entries", full);
      dispatch({ type:"ADD_THREAD", entry: full });
    } catch {
      // entry_type column missing — save without it
      await sb.insert("thread_entries", base);
      dispatch({ type:"ADD_THREAD", entry: base });
    }
  } catch(e) { console.error("logTaskEvent failed", e); }
};

// ── CONFIRM DIALOG HOOK ──
// Replaces window.confirm() throughout the app. Returns { confirmEl, confirm }.
// confirmEl must be rendered in the component's JSX (it's a portal-style overlay).
// confirm(message) returns a Promise<boolean> — await it then check the result.
function useConfirm() {
  const [state, setState] = React.useState(null); // { message, resolve }
  const confirm = React.useCallback((message) => {
    return new Promise(resolve => {
      setState({ message, resolve });
    });
  }, []);
  const handleChoice = (result) => {
    state?.resolve(result);
    setState(null);
  };
  const confirmEl = state ? (
    <div style={{
      position:"fixed", inset:0, zIndex:9999,
      background:"rgba(0,0,0,0.35)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }} onClick={() => handleChoice(false)}>
      <div onClick={e => e.stopPropagation()} style={{
        background:"white", borderRadius:12,
        boxShadow:"0 8px 32px rgba(0,0,0,0.22)",
        padding:"24px 28px", maxWidth:360, width:"90%",
        fontFamily:"inherit",
      }}>
        <div style={{ fontSize:14, fontWeight:500, color:C.text, lineHeight:1.5, marginBottom:20 }}>
          {state.message}
        </div>
        <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
          <span onClick={() => handleChoice(false)} style={{
            fontSize:12, fontWeight:500, cursor:"pointer",
            padding:"6px 16px", borderRadius:7,
            border:`0.5px solid ${C.borderMid}`, color:C.textMuted,
          }}>Cancel</span>
          <span onClick={() => handleChoice(true)} style={{
            fontSize:12, fontWeight:500, cursor:"pointer",
            padding:"6px 16px", borderRadius:7,
            background:C.red, color:"white", border:"none",
          }}>Confirm</span>
        </div>
      </div>
    </div>
  ) : null;
  return { confirmEl, confirm };
}

// ── CONSTANTS ──
const INSTRUMENTS = ["CIF","Escrow","SBLC","DLC","LC","FOB","BG","BF","Cash & Carry"];
const COMMODITIES = ["Gold Doré","Gold AU","Silver","Copper","Rough Diamonds","Tin","Lithium"];
const PRIORITIES = ["urgent","high","normal","low"];
const PRI_LABEL = { urgent:"*** Urgent", high:"** High", normal:"* Normal", low:"Low" };
// PRI_WORD: plain labels for use in pickers/selects where asterisks are
// already shown as a separate visual element. Using PRI_LABEL in pickers
// caused doubling (e.g. "** ** High"). (v9.3.59)
const PRI_WORD  = { urgent:"Urgent", high:"High", normal:"Normal", low:"Low" };
const CHANNELS = ["Note","Email","Call","WhatsApp","Meeting"];
const CH_COLOUR = {
  Note:    { bg:"#f4f3f2", text:"#444441", border:"#d3d1c7" },
  Email:   { bg:"#e6f1fb", text:"#185fa5", border:"#b5d4f4" },
  Call:    { bg:"#e8f5f3", text:"#1e6359", border:"#a8d5cd" },
  WhatsApp:{ bg:"#eeedfe", text:"#534ab7", border:"#afa9ec" },
  Meeting: { bg:"#faeeda", text:"#854f0b", border:"#fac775" },
};
const CH_ICON = {
  Note:    "ti-notes",
  Email:   "ti-mail",
  Call:    "ti-phone",
  WhatsApp:"ti-brand-whatsapp",
  Meeting: "ti-users",
};
const DOC_TYPES = ["SPA","LOI","FCO","ICPO","NCNDA","KYC","Export Docs","Proof of Funds","Other"];
const DEAL_STATES = ["lead","potential","active","dormant","closed_won","closed_lost"];
const HEAT_FLAMES = { "0":"", "1":"🔥", "2":"🔥🔥", "3":"🔥🔥🔥", "normal":"", "hot":"🔥🔥", "very_hot":"🔥🔥🔥" };
const STATE_COLOURS = {
  lead:        { bg:"#EEEDFE", text:"#3C3489", border:"#AFA9EC" },
  potential:   { bg:"#fff7ed", text:"#c2410c", border:"#fed7aa" },
  active:      { bg:"#e8f5f3", text:"#1e6359", border:"#a8d5cd" },
  dormant:     { bg:"#f9fafb", text:"#6b7280", border:"#e5e7eb" },
  closed_won:  { bg:"#f0fdf4", text:"#15803d", border:"#bbf7d0" },
  closed_lost: { bg:"#fff5f2", text:"#c0392b", border:"#f0c0b0" },
};
const PRI_COLOUR = {
  urgent: { bg:"#fff5f2", text:"#c0392b", border:"#f0c0b0" },
  high:   { bg:"#fff7ed", text:"#c2410c", border:"#fed7aa" },
  normal: { bg:"#eef2ff", text:"#3b5bdb", border:"#c5d3f8" },
  low:    { bg:"#f9fafb", text:"#6b7280", border:"#e5e7eb" },
};
const PRI_DOT = {
  urgent: { fill:"#E24B4A", label:"#A32D2D", bg:"#FCEBEB", border:"#F09595" },
  high:   { fill:"#EF9F27", label:"#633806", bg:"#FAEEDA", border:"#FAC775" },
  normal: { fill:"#639922", label:"#27500A", bg:"#EAF3DE", border:"#C0DD97" },
  low:    { fill:"#B4B2A9", label:"#5F5E5A", bg:"#F1EFE8", border:"#D3D1C7" },
};
const PRI_ORDER = { urgent:0, high:1, normal:2, low:3 };

// Asterisk count and colour per priority tier (v9.3.47).
// urgent = *** crimson, high = ** orange, normal = * green, low = no stars.
// Count alone carries the hierarchy — you don't need to know the colour
// scheme to read urgency: more stars = more urgent.
const PRI_STARS = { urgent:3, high:2, normal:1, low:0 };
const PRI_STAR_COLOUR = {
  urgent: "#7F1D1D",  // deep crimson — clearly distinct from high-orange
  high:   "#c2410c",  // orange
  normal: "#639922",  // green
  low:    null,
};

// ── COLOUR TOKENS ──
const C = {
  teal:         "#2a7d6e",
  tealLight:    "#e8f5f3",
  tealBorder:   "#a8d5cd",
  tealText:     "#1e6359",
  blue:         "#185fa5",
  blueLight:    "#e6f1fb",
  blueBorder:   "#b5d4f4",
  purple:       "#7C3AED",
  purpleLight:  "#F5F3FF",
  purpleBorder: "#C4B5FD",
  purpleDark:   "#5B21B6",
  purpleMid:    "#8B5CF6",
  purpleBadge:  "#3B0764",
  sidebar:      "#1e2433",
  sidebarHover: "#2a3347",
  sidebarBorder:"#2e3748",
  sidebarText:  "#ffffff",
  sidebarMuted: "#cbd5e1",
  panelHeader:  "#f8f9fa",
  bg:           "#ffffff",
  bgSecondary:  "#f8f9fa",
  border:       "#e5e7eb",
  borderMid:    "#e5e7eb",
  borderLight:  "#f0f0f0",
  text:         "#111827",
  textMuted:    "#6b7280",
  textDim:      "#9ca3af",
  red:          "#c0392b",
  redLight:     "#fff5f2",
  redBorder:    "#f0c0b0",
  green:        "#15803d",
  greenLight:   "#f0fdf4",
  greenBorder:  "#bbf7d0",
  amber:        "#c2410c",
  amberLight:   "#fff7ed",
  amberBorder:  "#fed7aa",
  orange:       "#EA580C",
  orangeLight:  "#FFF7ED",
  orangeBorder: "#FDBA74",
  orangeDark:   "#9A3412",
};

// ── SHARED PRIMITIVES ──
function Pill({ children, style, onClick }) {
  return (
    <span onClick={onClick} style={{
      display:"inline-flex", alignItems:"center", gap:4,
      borderRadius:999, padding:"4px 12px", fontSize:11, fontWeight:500,
      border:"1px solid", cursor: onClick ? "pointer" : "default",
      ...style
    }}>{children}</span>
  );
}

function StatePill({ state }) {
  const s = STATE_COLOURS[state] || STATE_COLOURS.potential;
  const labels = { potential:"Potential", active:"Active", dormant:"Dormant", closed_won:"Closed / Won", closed_lost:"Closed / Lost" };
  return <Pill style={{ background:s.bg, color:s.text, borderColor:s.border }}>{labels[state]||state}</Pill>;
}

function InstrPill({ instrument }) {
  return <Pill style={{ background:"#f0f4ff", color:"#3b5bdb", borderColor:"#c5d3f8" }}>{instrument}</Pill>;
}

function CommodityPill({ commodity }) {
  return <Pill style={{ background:"#fef9ee", color:"#92400e", borderColor:"#fcd34d" }}>{commodity}</Pill>;
}


function Btn({ children, onClick, variant="default", style }) {
  const [hovered, setHovered] = useState(false);
  const variants = {
    default: {
      base:  { background:"white", color:C.text, borderColor:C.borderMid, border:"1px solid" },
      hover: { background:C.bgSecondary, borderColor:C.textMuted },
    },
    teal: {
      base:  { background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, border:"1px solid" },
      hover: { background:"#d4eeea" },
    },
    blue: {
      base:  { background:C.blueLight, color:C.blue, borderColor:C.blueBorder, border:"1px solid" },
      hover: { background:"#d0e8f8" },
    },
    red: {
      base:  { background:C.redLight, color:C.red, borderColor:C.redBorder, border:"1px solid" },
      hover: { background:"#fce8e4" },
    },
    solid: {
      base:  { background:C.teal, color:"#fff", borderColor:C.teal, border:"1px solid",
               boxShadow:"0 1px 4px rgba(42,125,110,0.25)" },
      hover: { background:"#1e6359", borderColor:"#1e6359", boxShadow:"0 2px 8px rgba(42,125,110,0.35)" },
    },
  };
  const v = variants[variant] || variants.default;
  const merged = { ...v.base, ...(hovered ? v.hover : {}), ...style };
  return (
    <span
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display:"inline-flex", alignItems:"center", gap:5,
        borderRadius:999, padding:"6px 16px", fontSize:11, fontWeight:500,
        cursor:"pointer", userSelect:"none", transition:"all 0.12s",
        ...merged
      }}
    >{children}</span>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize:10, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:C.textMuted, marginBottom:6 }}>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height:"1px", background:C.border, margin:"14px 0" }} />;
}

// ── DRAGGABLE PANEL HOOK ──
function useDraggablePanel(defaultWidth, min, max) {
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      setWidth(Math.min(max, Math.max(min, startW.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width, min, max]);

  return [width, onMouseDown];
}

function DragHandle({ onMouseDown }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 4, flexShrink:0, cursor:"col-resize", position:"relative",
        background: hovered ? C.tealBorder : "transparent", transition:"background 0.15s",
        zIndex:2,
      }}
    >
      {/* Visual pill indicator on hover */}
      {hovered && (
        <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)",
          width:3, height:32, borderRadius:999, background:C.teal }} />
      )}
    </div>
  );
}

// ── REDUCER ──
function reducer(s, a) {
  switch (a.type) {
    case "LOAD":
      // Second line of defence: once data has loaded for this session,
      // a LOAD should never silently clobber live state. If this ever
      // needs to be a genuine "refresh from server" action in future,
      // give it its own action type (e.g. "RELOAD") rather than relying
      // on LOAD firing twice.
      if (s.loaded) {
        console.warn("LOAD dispatched after initial load — ignoring to protect in-memory state.");
        return s;
      }
      return { ...s, ...a.payload, loaded: true };
    case "SET_DEALS": return { ...s, deals: a.deals };
    case "ADD_DEAL": return { ...s, deals: { ...s.deals, [a.deal.id]: a.deal } };
    case "UPDATE_DEAL": return { ...s, deals: { ...s.deals, [a.id]: { ...s.deals[a.id], ...a.updates } } };
    case "DELETE_DEAL": { const d = { ...s.deals }; delete d[a.id]; return { ...s, deals: d }; }
    case "ADD_DEAL_SELLER": return { ...s, dealSellers: { ...s.dealSellers, [a.ds.id]: a.ds } };
    case "UPDATE_DEAL_SELLER": return { ...s, dealSellers: { ...s.dealSellers, [a.id]: { ...s.dealSellers[a.id], ...a.updates } } };
    case "DELETE_DEAL_SELLER": { const ds = { ...s.dealSellers }; delete ds[a.id]; return { ...s, dealSellers: ds }; }
    case "ADD_SELLER": return { ...s, sellers: { ...s.sellers, [a.seller.id]: a.seller } };
    case "UPDATE_SELLER": return { ...s, sellers: { ...s.sellers, [a.id]: { ...s.sellers[a.id], ...a.updates } } };
    case "DELETE_SELLER": { const sl = { ...s.sellers }; delete sl[a.id]; return { ...s, sellers: sl }; }
    case "ADD_BUYER": return { ...s, buyers: { ...s.buyers, [a.buyer.id]: a.buyer } };
    case "UPDATE_BUYER": return { ...s, buyers: { ...s.buyers, [a.id]: { ...s.buyers[a.id], ...a.updates } } };
    case "DELETE_BUYER": { const b = { ...s.buyers }; delete b[a.id]; return { ...s, buyers: b }; }
    case "ADD_PERSON": return { ...s, people: { ...s.people, [a.person.id]: a.person } };
    case "UPDATE_PERSON": return { ...s, people: { ...s.people, [a.id]: { ...s.people[a.id], ...a.updates } } };
    case "DELETE_PERSON": { const p = { ...s.people }; delete p[a.id]; return { ...s, people: p }; }
    case "ADD_TASK": return { ...s, tasks: { ...s.tasks, [a.task.id]: a.task } };
    case "UPDATE_TASK": return { ...s, tasks: { ...s.tasks, [a.id]: { ...s.tasks[a.id], ...a.updates } } };
    case "DELETE_TASK": { const t = { ...s.tasks }; delete t[a.id]; return { ...s, tasks: t }; }
    case "ADD_THREAD": return { ...s, threads: { ...s.threads, [a.entry.id]: a.entry } };
    case "UPDATE_THREAD": return { ...s, threads: { ...s.threads, [a.id]: { ...s.threads[a.id], ...a.updates } } };
    case "DELETE_THREAD": { const th = { ...s.threads }; delete th[a.id]; return { ...s, threads: th }; }
    case "ADD_DOCUMENT": return { ...s, documents: { ...s.documents, [a.doc.id]: a.doc } };
    case "UPDATE_DOCUMENT": return { ...s, documents: { ...s.documents, [a.id]: { ...s.documents[a.id], ...a.updates } } };
    case "DELETE_DOCUMENT": { const dc = { ...s.documents }; delete dc[a.id]; return { ...s, documents: dc }; }
    case "SAVE_JOURNAL": return { ...s, journal: { ...s.journal, [a.date]: { date: a.date, text: a.text, updated_at: nowISO() } } };
    default: return s;
  }
}

const INIT = {
  loaded: false,
  deals: {}, dealSellers: {}, sellers: {}, buyers: {}, people: {},
  tasks: {}, threads: {}, documents: {}, journal: {},
};

// ── LOAD FROM SUPABASE ──
async function loadAll() {
  const [deals, dealSellers, sellers, buyers, people, tasks, threads, documents, journal] = await Promise.all([
    sb.select("deals", "archived=neq.true&order=created_at.desc"),
    sb.select("deal_sellers"),
    sb.select("sellers"),
    sb.select("buyers"),
    sb.select("people"),
    sb.select("tasks"),
    sb.select("thread_entries"),
    sb.select("documents"),
    sb.select("journal", "order=date.desc"),
  ]);
  const toMap = (arr, key = "id") => arr.reduce((m, r) => { m[r[key]] = r; return m; }, {});
  const jMap = journal.reduce((m, r) => { m[r.date] = r; return m; }, {});
  return {
    deals: toMap(deals),
    dealSellers: toMap(dealSellers),
    sellers: toMap(sellers),
    buyers: toMap(buyers),
    people: toMap(people),
    tasks: toMap(tasks),
    threads: toMap(threads),
    documents: toMap(documents),
    journal: jMap,
  };
}

// ── BOARD VIEW ──
function BoardView({ state, dispatch, onSelectDeal, initialTab, onTabChange, onNavigateToTasks }) {
  const [filterInstr, setFilterInstr] = useState("");
  const [filterComm, setFilterComm] = useState("");
  const [filterHeat, setFilterHeat] = useState("");
  const [showDormant, setShowDormant] = useState(false);
  const [showAddDeal, setShowAddDeal] = useState(false);
  const [showAddLead, setShowAddLead] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab || "active");
  const [showTodayOnly, setShowTodayOnly] = useState(false);
  // Lead sort: default ascending = oldest reminder date first = most overdue
  // at the top. This matches the convention already used by the Tasks
  // screen's Overdue section, and is the sensible default for a section
  // whose entire purpose is to surface what's been neglected longest.
  // The toggle lets a user flip to descending if their workflow prefers it.
  const [leadSortAsc, setLeadSortAsc] = useState(true);
  const [boardSearch, setBoardSearch] = useState("");

  // Switch tab when navigated from outside (e.g. clicking Lead pill in tasks)
  useEffect(() => {
    if (initialTab) { setActiveTab(initialTab); if (onTabChange) onTabChange(); }
  }, [initialTab]);

  const deals = Object.values(state.deals).filter(d => !d.archived);

  const OLD_POTENTIAL = ["new","potential","New Opportunity","LOI","FCO / SPA"];
  const OLD_ACTIVE = ["in_progress","active","Export Docs","Shipping"];

  const dealState = (d) => {
    if (d.state === "lead") return "lead";
    if (d.state === "active" || OLD_ACTIVE.includes(d.state)) return "active";
    if (d.state === "dormant") return "dormant";
    return "potential";
  };

  const filtered = deals.filter(d => {
    if (filterInstr && d.instrument !== filterInstr) return false;
    if (filterComm && d.commodity !== filterComm) return false;
    if (filterHeat && d.heat !== filterHeat) return false;
    return true;
  });

  const heatVal = (d) => {
    const h = d.heat;
    if (h === "very_hot" || h === "3") return 3;
    if (h === "hot" || h === "2") return 2;
    if (h === "1") return 1;
    return 0;
  };

  const laneSort = (a, b) => {
    const tA = new Date(a.updated_at || a.created_at || 0).getTime();
    const tB = new Date(b.updated_at || b.created_at || 0).getTime();
    if (tB !== tA) return tB - tA;
    return heatVal(b) - heatVal(a);
  };

  // Single source of truth for a lead's reminder date/note: the linked,
  // open lead task (card_type "lead", not completed/archived). Replaces
  // the old deals.lead_reminder_date / lead_reminder_note fields, which
  // could silently drift out of sync with the task's own due_date when
  // the task was edited directly from the registry instead of via the
  // lead's reminder panel. (Fixed v9.3.42 — see DESIGN_DECISIONS.)
  // leadLinkedTask: returns the earliest-due incomplete task for a lead,
  // regardless of card_type. Tasks added from the registry against a lead
  // get card_type:"deal" (not "lead"), so filtering on card_type here
  // would miss them. card_id is the reliable join key.
  const leadLinkedTask = (dealId) => {
    const tasks = Object.values(state.tasks).filter(
      t => t.card_id === dealId && t.status !== "completed" && t.status !== "archived"
    );
    if (!tasks.length) return null;
    // Overdue first, then earliest due date, then undated last
    return tasks.sort((a,b) => {
      const aDate = a.due_date || "9999";
      const bDate = b.due_date || "9999";
      return aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
    })[0];
  };

  // Leads sort by their linked task's due_date (the date shown on the
  // card as "Overdue ·" / "Follow up"), not by updated_at. Leads with no
  // linked task / no due date at all sort to the end regardless of
  // direction, since they have no date to compare and shouldn't be mixed
  // into either the overdue or upcoming ordering arbitrarily.
  const leadReminderSort = (a, b) => {
    const dA = leadLinkedTask(a.id)?.due_date, dB = leadLinkedTask(b.id)?.due_date;
    if (!dA && !dB) return heatVal(b) - heatVal(a);
    if (!dA) return 1;
    if (!dB) return -1;
    return leadSortAsc ? (dA < dB ? -1 : dA > dB ? 1 : 0) : (dA > dB ? -1 : dA < dB ? 1 : 0);
  };

  const hasFilters = filterInstr || filterComm || filterHeat;
  const clearFilters = () => { setFilterInstr(""); setFilterComm(""); setFilterHeat(""); setShowTodayOnly(false); };

  // Today filter: cards with tasks due today/overdue OR lead reminder date today/overdue
  const todayFilteredIds = showTodayOnly ? new Set(
    Object.values(state.tasks)
      .filter(t => t.status !== "completed" && t.status !== "archived" && t.due_date && t.due_date <= todayStr())
      .map(t => t.card_id)
      .filter(Boolean)
  ) : null;

  const taskCount = (dealId) => Object.values(state.tasks).filter(t => t.card_id === dealId && t.status !== "completed" && t.status !== "archived").length;
  const overdueCount = (dealId) => Object.values(state.tasks).filter(t => t.card_id === dealId && isOverdue(t.due_date) && t.status !== "completed" && t.status !== "archived").length;
  const sellerSummary = (dealId) => {
    const ds = Object.values(state.dealSellers).filter(x => x.deal_id === dealId);
    const primary = ds.find(x => x.role === "primary");
    if (primary) {
      const seller = state.sellers[primary.seller_id];
      return { text: seller ? (seller.company_name || seller.name) : "Primary seller", isPrimary: true };
    }
    if (ds.length > 0) return { text: `${ds.length} candidate${ds.length > 1 ? "s" : ""}`, isPrimary: false };
    return { text: "No seller matched", isPrimary: false };
  };

  const applyTodayFilter = (deals) => {
    if (!showTodayOnly) return deals;
    return deals.filter(d => {
      if (todayFilteredIds && todayFilteredIds.has(d.id)) return true;
      // Lead cards: also check their linked task's due_date
      if (d.state === "lead" && leadLinkedTask(d.id)?.due_date && leadLinkedTask(d.id).due_date <= todayStr()) return true;
      return false;
    });
  };

  const tabDeals = (tab) => {
    if (tab === "lead") return applyTodayFilter(filtered.filter(d => dealState(d) === "lead")).sort(leadReminderSort);
    if (tab === "active") {
      const base = applyTodayFilter(filtered.filter(d => dealState(d) === "active")).sort(laneSort);
      if (!showDormant) return base;
      return [...base, ...applyTodayFilter(filtered.filter(d => dealState(d) === "dormant")).sort(laneSort)];
    }
    if (tab === "potential") {
      const base = applyTodayFilter(filtered.filter(d => dealState(d) === "potential")).sort(laneSort);
      if (!showDormant) return base;
      return [...base, ...applyTodayFilter(filtered.filter(d => dealState(d) === "dormant")).sort(laneSort)];
    }
    return [];
  };

  const leadCount     = filtered.filter(d => dealState(d) === "lead").length;
  const potentialCount = filtered.filter(d => dealState(d) === "potential").length;
  const activeCount   = filtered.filter(d => dealState(d) === "active").length;

  // Word-by-word AND search across the fields actually shown on a card.
  // Every typed word must appear somewhere in the combined searchable
  // text for a card to match — order and field don't matter, so
  // "copper zambia" matches a card with "Zambia" in the title and
  // "Copper" in the commodity pill, with no need for an exact phrase.
  const searchWords = boardSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const applyBoardSearch = (deals) => {
    if (searchWords.length === 0) return deals;
    return deals.filter(d => {
      const haystack = [
        d.deal_name, d.buyer_name, d.location, d.relationship_type,
        d.instrument, d.commodity, d.quantity, d.description,
        sellerSummary(d.id).text,
      ].filter(Boolean).join(" ").toLowerCase();
      return searchWords.every(w => haystack.includes(w));
    });
  };

  const visibleDeals  = applyBoardSearch(tabDeals(activeTab));

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden", background:C.bg }}>
      {/* Topbar */}
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 16px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, flexShrink:0, flexWrap:"wrap" }}>
        <span style={{ fontSize:13, fontWeight:500, color:C.text, marginRight:4 }}>Board</span>
        <input
          value={boardSearch}
          onChange={e => setBoardSearch(e.target.value)}
          placeholder="Search this tab…"
          style={{
            border:`0.5px solid ${boardSearch ? C.tealBorder : C.borderMid}`,
            borderRadius:999, padding:"4px 12px", fontSize:11, fontFamily:"inherit",
            outline:"none", color:C.text, width:160, background:C.bg
          }}
        />
        {boardSearch && (
          <span onClick={() => setBoardSearch("")} style={{ fontSize:11, color:C.textDim, cursor:"pointer", marginRight:2 }}>✕</span>
        )}
        {[
          { label:"Instrument", value:filterInstr, set:setFilterInstr, opts:INSTRUMENTS },
          { label:"Commodity",  value:filterComm,  set:setFilterComm,  opts:COMMODITIES },
          { label:"Heat",       value:filterHeat,  set:setFilterHeat,  opts:["1","2","3"] },
        ].map(f => (
          <select key={f.label} value={f.value} onChange={e => f.set(e.target.value)} style={{
            appearance:"none", border:`0.5px solid ${f.value ? C.tealBorder : C.borderMid}`,
            borderRadius:999, padding:"3px 12px", fontSize:11, fontWeight:500,
            background: f.value ? C.tealLight : C.bg, color: f.value ? C.tealText : C.textMuted,
            cursor:"pointer", fontFamily:"inherit"
          }}>
            <option value="">{f.label}</option>
            {f.opts.map(o => <option key={o} value={o}>{f.label === "Heat" ? HEAT_FLAMES[o] || o : o}</option>)}
          </select>
        ))}
        <span onClick={() => setShowTodayOnly(!showTodayOnly)} style={{
          fontSize:11, fontWeight:500, cursor:"pointer", borderRadius:999, padding:"3px 11px",
          border:`0.5px solid ${showTodayOnly ? C.blueBorder : C.borderMid}`,
          background: showTodayOnly ? C.blueLight : "transparent",
          color: showTodayOnly ? C.blue : C.textMuted
        }}>Today</span>
        {activeTab === "lead" && (
          <span onClick={() => setLeadSortAsc(!leadSortAsc)} title="Sort leads by follow-up date" style={{
            fontSize:11, fontWeight:500, cursor:"pointer", borderRadius:999, padding:"3px 11px",
            border:`0.5px solid ${C.borderMid}`, background:"transparent", color:C.textMuted,
            display:"inline-flex", alignItems:"center", gap:4
          }}>{leadSortAsc ? "↑ Oldest first" : "↓ Newest first"}</span>
        )}
        {(hasFilters || showTodayOnly) && (
          <span onClick={clearFilters} style={{ fontSize:11, color:C.red, cursor:"pointer", borderRadius:999, padding:"3px 10px", border:`0.5px solid ${C.redBorder}`, background:C.redLight }}>
            Clear all
          </span>
        )}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8 }}>
          <span onClick={() => setShowAddLead(true)} style={{
            fontSize:12, fontWeight:500, borderRadius:999, padding:"4px 14px",
            background:C.orangeLight, color:C.orangeDark, border:`0.5px solid ${C.orangeBorder}`,
            cursor:"pointer"
          }}>+ Lead</span>
          <Btn variant="teal" onClick={() => setShowAddDeal(true)}>+ Deal</Btn>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display:"flex", alignItems:"stretch", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, padding:"0 16px", flexShrink:0 }}>
        {[
          { key:"lead",      label:"Leads",    count:leadCount,      accent:true },
          { key:"potential", label:"Potential", count:potentialCount, accent:false },
          { key:"active",    label:"Active",   count:activeCount,    accent:false },
        ].map(tab => (
          <div key={tab.key} onClick={() => { setActiveTab(tab.key); if (onTabChange) onTabChange(tab.key); }} style={{
            display:"flex", alignItems:"center", gap:6, padding:"8px 14px",
            borderBottom: activeTab === tab.key
              ? `2px solid ${tab.accent ? C.purpleMid : C.teal}`
              : "2px solid transparent",
            cursor:"pointer", marginBottom:"-0.5px"
          }}>
            {tab.accent && activeTab === tab.key && (
              <span style={{ width:7, height:7, borderRadius:"50%", background:C.purpleMid, display:"inline-block", flexShrink:0 }} />
            )}
            <span style={{
              fontSize:12, fontWeight:500,
              color: activeTab === tab.key ? (tab.accent ? C.purpleDark : C.tealText) : C.textMuted
            }}>{tab.label}</span>
            <span style={{
              fontSize:10, borderRadius:999, padding:"1px 7px", fontWeight:500,
              background: activeTab === tab.key ? (tab.accent ? "#AFA9EC" : C.tealLight) : C.bgSecondary,
              color: activeTab === tab.key ? (tab.accent ? C.purpleBadge : C.tealText) : C.textMuted,
              border:`0.5px solid ${activeTab === tab.key ? (tab.accent ? C.purpleBorder : C.tealBorder) : C.border}`
            }}>{tab.count}</span>
          </div>
        ))}
        {activeTab !== "lead" && (
          <div style={{ marginLeft:"auto", display:"flex", alignItems:"center" }}>
            <span onClick={() => setShowDormant(!showDormant)} style={{
              fontSize:11, fontWeight:500, cursor:"pointer", borderRadius:999, padding:"3px 11px",
              border:`0.5px solid ${showDormant ? C.borderMid : C.border}`,
              background: showDormant ? C.bgSecondary : "transparent", color:C.textMuted
            }}>{showDormant ? "Hide dormant" : "Show dormant"}</span>
          </div>
        )}
      </div>

      {/* Canvas */}
      <div style={{ flex:1, overflowY:"auto", padding:16 }}>
        {visibleDeals.length === 0 ? (
          <div style={{ padding:"40px 0", fontSize:12, color:C.textDim, fontStyle:"italic", textAlign:"center" }}>
            No {activeTab === "lead" ? "leads" : activeTab === "active" ? "active deals" : "potential deals"}
          </div>
        ) : activeTab === "lead" ? (() => {
          const today = todayStr();
          const overdueLeads = visibleDeals.filter(d => { const dt = leadLinkedTask(d.id)?.due_date; return dt && dt < today; });
          const otherLeads = visibleDeals.filter(d => { const dt = leadLinkedTask(d.id)?.due_date; return !dt || dt >= today; });
          const renderGrid = (items) => (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(175px, 1fr))", gap:8 }}>
              {items.map(deal => (
                <LeadCard key={deal.id} deal={deal} linkedTask={leadLinkedTask(deal.id)} onClick={() => onSelectDeal(deal.id)} onTasksClick={() => onNavigateToTasks && onNavigateToTasks(deal.id)} searchWords={searchWords} />
              ))}
            </div>
          );
          return (
            <>
              {overdueLeads.length > 0 && <>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
                  <span style={{ fontSize:11, fontWeight:600, color:C.red, textTransform:"uppercase", letterSpacing:"0.04em" }}>⚠ Overdue</span>
                  <span style={{ fontSize:10, color:C.red, background:C.redLight, border:`0.5px solid ${C.redBorder}`, borderRadius:999, padding:"1px 7px" }}>{overdueLeads.length}</span>
                </div>
                {renderGrid(overdueLeads)}
              </>}
              {otherLeads.length > 0 && <>
                <div style={{ display:"flex", alignItems:"center", gap:6, margin: overdueLeads.length > 0 ? "16px 0 8px" : "0 0 8px" }}>
                  <span style={{ fontSize:11, fontWeight:600, color:C.textMuted, textTransform:"uppercase", letterSpacing:"0.04em" }}>Current &amp; Upcoming</span>
                  <span style={{ fontSize:10, color:C.textMuted, background:C.bgSecondary, border:`0.5px solid ${C.border}`, borderRadius:999, padding:"1px 7px" }}>{otherLeads.length}</span>
                </div>
                {renderGrid(otherLeads)}
              </>}
            </>
          );
        })() : (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(175px, 1fr))", gap:8 }}>
            {visibleDeals.map(deal => (
              <BoardCard
                key={deal.id}
                deal={deal}
                taskCount={taskCount(deal.id)}
                overdueCount={overdueCount(deal.id)}
                sellerSummary={sellerSummary(deal.id)}
                onClick={() => onSelectDeal(deal.id)}
                isActive={dealState(deal) === "active"}
                searchWords={searchWords}
              />
            ))}
          </div>
        )}
      </div>

      {showAddDeal && (
        <AddDealModal state={state} dispatch={dispatch} onClose={() => setShowAddDeal(false)}
          onCreated={(id) => onSelectDeal(id)} />
      )}
      {showAddLead && (
        <AddLeadModal state={state} dispatch={dispatch} onClose={() => { setShowAddLead(false); setActiveTab("lead"); }}
          onCreated={(id) => onSelectDeal(id)} />
      )}
    </div>
  );
}

// Wraps any matched search word in a highlighted span. Used to make the
// title visibly prominent when a board search is active, rather than just
// filtering the list with no visual cue for why a card matched.
function HighlightedText({ text, words }) {
  if (!text || !words || words.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = String(text).split(pattern);
  return <>{parts.map((part, i) =>
    words.some(w => part.toLowerCase() === w.toLowerCase())
      ? <span key={i} style={{ background:"#fde68a", color:"#78350f", borderRadius:3, padding:"0 2px", fontWeight:600 }}>{part}</span>
      : part
  )}</>;
}

function BoardCard({ deal, taskCount, overdueCount, sellerSummary, onClick, isActive, searchWords }) {
  return (
    <div onClick={onClick} style={{
      background:C.bg,
      border:`1px solid ${isActive ? C.teal : C.border}`,
      borderLeft: isActive ? `4px solid ${C.teal}` : `1px solid ${C.border}`,
      borderRadius:10, padding:"11px 13px", cursor:"pointer",
      boxShadow: isActive ? "0 2px 12px rgba(42,125,110,0.12)" : "0 1px 3px rgba(0,0,0,0.06)",
      transition:"box-shadow 0.15s, border-color 0.15s",
    }}
    onMouseEnter={e => { e.currentTarget.style.boxShadow = "0 4px 16px rgba(0,0,0,0.1)"; e.currentTarget.style.borderColor = isActive ? C.teal : C.borderMid; }}
    onMouseLeave={e => { e.currentTarget.style.boxShadow = isActive ? "0 2px 12px rgba(42,125,110,0.12)" : "0 1px 3px rgba(0,0,0,0.06)"; e.currentTarget.style.borderColor = isActive ? C.teal : C.border; }}
    >
      {/* Header row */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
        <div style={{ fontSize:12, fontWeight:500, color:C.text, lineHeight:1.3, flex:1, paddingRight:4 }}>
          <HighlightedText text={deal.deal_name || deal.buyer_name || "Unnamed deal"} words={searchWords} />
        </div>
        {deal.heat && deal.heat !== "0" && (
          <span style={{ fontSize:12, flexShrink:0 }}>{HEAT_FLAMES[deal.heat]}</span>
        )}
      </div>
      {/* Location / relationship */}
      {(deal.location || deal.relationship_type) && (
        <div style={{ fontSize:10, color:C.textMuted, marginBottom:6 }}>
          {[deal.location, deal.relationship_type].filter(Boolean).join(" · ")}
        </div>
      )}
      {/* Pills */}
      <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:8 }}>
        {deal.instrument && <InstrPill instrument={deal.instrument} />}
        {deal.commodity && <CommodityPill commodity={deal.commodity} />}
      </div>
      {/* Quantity */}
      {deal.quantity && (
        <div style={{ fontSize:10, color:C.textMuted, marginBottom:6 }}>{deal.quantity}</div>
      )}
      {/* Footer */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", paddingTop:6, borderTop:`0.5px solid ${C.border}` }}>
        <div style={{ fontSize:10, color: sellerSummary.isPrimary ? C.tealText : C.textDim, fontWeight: sellerSummary.isPrimary ? 500 : 400, maxWidth:"60%", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {sellerSummary.text}
        </div>
        {taskCount > 0 && (
          <span style={{ fontSize:10, color: overdueCount > 0 ? C.red : C.textMuted, background: overdueCount > 0 ? C.redLight : C.bgSecondary, borderRadius:999, padding:"1px 6px", border:`0.5px solid ${overdueCount > 0 ? C.redBorder : C.border}`, fontWeight: overdueCount > 0 ? 500 : 400 }}>
            {overdueCount > 0 ? `${overdueCount} overdue` : `${taskCount} task${taskCount > 1 ? "s" : ""}`}
          </span>
        )}
      </div>
    </div>
  );
}

// ── LEAD CARD ──
function LeadCard({ deal, linkedTask, onClick, onTasksClick, searchWords }) {
  // Derive earliest upcoming/overdue task due date for this lead
  const reminderDate = linkedTask?.due_date;
  const isOverdueReminder = reminderDate && reminderDate < todayStr();
  const isTodayReminder = reminderDate && reminderDate === todayStr();
  const title = deal.deal_name || [deal.commodity, deal.location].filter(Boolean).join(" · ") || "New lead";
  return (
    <div onClick={onClick} style={{
      background:C.bg, border:`0.5px solid ${C.border}`,
      borderRadius:10, overflow:"hidden", cursor:"pointer",
      transition:"box-shadow 0.15s", boxShadow:"0 1px 4px rgba(0,0,0,0.06)"
    }}
    onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 14px rgba(0,0,0,0.1)"}
    onMouseLeave={e => e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.06)"}
    >
      {/* Orange top band */}
      <div style={{ background:C.orange, padding:"6px 12px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span style={{ fontSize:10, fontWeight:600, color:"#fff", letterSpacing:"0.05em", textTransform:"uppercase" }}>Lead</span>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          {deal.heat && deal.heat !== "0" && (
            <span style={{ fontSize:12, lineHeight:1 }}>{HEAT_FLAMES[deal.heat]}</span>
          )}
          {deal.lead_side && (
            <span style={{ fontSize:10, color:"rgba(255,255,255,0.85)", fontWeight:500 }}>{deal.lead_side}</span>
          )}
        </div>
      </div>
      {/* Card body */}
      <div style={{ padding:"10px 12px" }}>
        <div style={{ fontSize:12, fontWeight:500, color:C.text, marginBottom:4, lineHeight:1.35 }}><HighlightedText text={title} words={searchWords} /></div>
        {deal.commodity && (
          <div style={{ marginBottom:8 }}><CommodityPill commodity={deal.commodity} /></div>
        )}
        <div style={{ borderTop:`0.5px solid ${C.border}`, paddingTop:6, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            {isOverdueReminder ? (
              <span style={{ fontSize:10, color:C.red, fontWeight:500 }}>⚠ Overdue · {fmtDate(reminderDate)}</span>
            ) : isTodayReminder ? (
              <span style={{ fontSize:10, color:C.orange, fontWeight:500 }}>Today</span>
            ) : reminderDate ? (
              <span style={{ fontSize:10, color:C.textMuted }}>Follow up {fmtDate(reminderDate)}</span>
            ) : (
              <span style={{ fontSize:10, color:C.textDim }}>No tasks</span>
            )}
          </div>
          {/* Tasks link — fix 2 */}
          <span
            onClick={e => { e.stopPropagation(); onTasksClick && onTasksClick(); }}
            style={{ fontSize:10, color:C.orange, cursor:"pointer", fontWeight:500, padding:"1px 6px", borderRadius:999, border:`0.5px solid ${C.orangeBorder}`, background:C.orangeLight }}
            title="View tasks for this lead"
          >Tasks</span>
        </div>
      </div>
    </div>
  );
}

// ── ADD LEAD MODAL ──
function AddLeadModal({ state, dispatch, onClose, onCreated }) {
  const [commodity, setCommodity] = useState("");
  const [side, setSide] = useState("Buyer");
  const [country, setCountry] = useState("");
  const [dealName, setDealName] = useState("");
  const [dealNameTouched, setDealNameTouched] = useState(false);
  const [heat, setHeat] = useState("0");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  // Auto-generate deal name from commodity + country unless user has edited it
  const autoName = [commodity, country.trim()].filter(Boolean).join(" · ");
  const effectiveDealName = dealNameTouched ? dealName : autoName;

  const canSave = commodity && country.trim();
  const inputStyle = { width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:8, padding:"7px 10px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, boxSizing:"border-box" };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const leadId = genId();
      const lead = {
        id: leadId, deal_name: effectiveDealName || `${commodity} · ${country.trim()}`,
        description: note.trim(), buyer_id:null, buyer_name:"",
        location: country.trim(), commodity, instrument:"", quantity:"",
        state:"lead", lead_side:side,
        heat, archived:false, created_at:nowISO()
      };
      await sb.insert("deals", lead);
      dispatch({ type:"ADD_DEAL", deal:lead });
      if (onCreated) onCreated(leadId); // focus the new card (v9.3.101)
      onClose();
    } catch(e) { console.error(e); } finally { setSaving(false); }
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background:C.bg, borderRadius:12, width:380, maxHeight:"85vh", overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ padding:"14px 20px", borderBottom:`0.5px solid ${C.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ width:9, height:9, borderRadius:"50%", background:C.purpleMid, display:"inline-block" }} />
            <span style={{ fontSize:14, fontWeight:500, color:C.text }}>New lead</span>
          </div>
          <span onClick={onClose} style={{ cursor:"pointer", fontSize:18, color:C.textMuted, lineHeight:1 }}>×</span>
        </div>
        <div style={{ padding:"16px 20px", flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:14 }}>
          <div>
            <SectionLabel>Commodity</SectionLabel>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {COMMODITIES.map(c => (
                <span key={c} onClick={() => setCommodity(c)} style={{
                  fontSize:11, fontWeight:500, borderRadius:999, padding:"3px 11px",
                  border:`0.5px solid ${commodity===c ? C.orangeBorder : C.borderMid}`,
                  background: commodity===c ? C.orangeLight : C.bg,
                  color: commodity===c ? C.orangeDark : C.textMuted, cursor:"pointer"
                }}>{c}</span>
              ))}
            </div>
          </div>
          <div>
            <SectionLabel>Side</SectionLabel>
            <div style={{ display:"flex", gap:6 }}>
              {["Buyer","Seller"].map(s => (
                <span key={s} onClick={() => setSide(s)} style={{
                  fontSize:11, fontWeight:500, borderRadius:999, padding:"3px 14px",
                  border:`0.5px solid ${side===s ? C.orangeBorder : C.borderMid}`,
                  background: side===s ? C.orangeLight : C.bg,
                  color: side===s ? C.orangeDark : C.textMuted, cursor:"pointer"
                }}>{s}</span>
              ))}
            </div>
          </div>
          <div>
            <SectionLabel>Heat</SectionLabel>
            <div style={{ display:"flex", gap:6 }}>
              {["0","1","2","3"].map(h => (
                <span key={h} onClick={() => setHeat(h)} style={{
                  fontSize:13, borderRadius:999, padding:"3px 12px",
                  border:`0.5px solid ${heat===h ? C.orangeBorder : C.borderMid}`,
                  background: heat===h ? C.orangeLight : C.bg,
                  cursor:"pointer", minWidth:40, textAlign:"center"
                }}>{HEAT_FLAMES[h] || "None"}</span>
              ))}
            </div>
          </div>
          <div>
            <SectionLabel>Country / region</SectionLabel>
            <input value={country} onChange={e => setCountry(e.target.value)} placeholder="e.g. Switzerland" style={inputStyle} autoFocus />
          </div>
          <div>
            <SectionLabel>Deal name <span style={{ fontWeight:400, color:C.textDim }}>(optional — auto-generated if blank)</span></SectionLabel>
            <input
              value={effectiveDealName}
              onChange={e => { setDealName(e.target.value); setDealNameTouched(true); }}
              onFocus={() => { if (!dealNameTouched) setDealName(autoName); setDealNameTouched(true); }}
              placeholder={autoName || "e.g. Gold Doré · Dubai"}
              style={inputStyle}
            />
          </div>
          <div>
            <SectionLabel>Note <span style={{ fontWeight:400, color:C.textDim }}>(optional)</span></SectionLabel>
            <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="How it came in, who mentioned it…" rows={3}
              style={{ ...inputStyle, resize:"vertical", lineHeight:1.5 }} />
          </div>
        </div>
        <div style={{ padding:"12px 20px", borderTop:`0.5px solid ${C.border}`, display:"flex", justifyContent:"flex-end", gap:8 }}>
          <span onClick={onClose} style={{ fontSize:12, fontWeight:500, borderRadius:999, padding:"5px 14px", border:`0.5px solid ${C.border}`, color:C.textMuted, cursor:"pointer" }}>Cancel</span>
          <span onClick={handleSave} style={{
            fontSize:12, fontWeight:500, borderRadius:999, padding:"5px 14px",
            background: canSave ? C.orangeLight : C.bgSecondary,
            color: canSave ? C.orangeDark : C.textDim,
            border:`0.5px solid ${canSave ? C.orangeBorder : C.border}`,
            cursor: canSave ? "pointer" : "not-allowed", opacity: saving ? 0.6 : 1
          }}>{saving ? "Saving…" : "Save lead"}</span>
        </div>
      </div>
    </div>
  );
}

// ── LEAD PANEL ──
function LeadPanel({ deal, state, dispatch, onClose, onNavigateToTasks, onQualified }) {
  const [tab, setTab] = useState("info");
  const [showQualify, setShowQualify] = useState(false);

  // Info edit state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    deal_name:   deal.deal_name || "",
    commodity:   deal.commodity || "",
    lead_side:   deal.lead_side || "Buyer",
    location:    deal.location  || "",
    description: deal.description || "",
    heat:        deal.heat || "0",
  });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [actioning, setActioning] = useState(false);
  const [showCloseResolutionPrompt, setShowCloseResolutionPrompt] = useState(false);
  const [closeResolutionText, setCloseResolutionText] = useState("");

  const [savingInfo, setSavingInfo] = useState(false);

  // Tasks tab state
  const [ltTitle, setLtTitle] = useState("");
  const [ltDescription, setLtDescription] = useState("");
  const [ltDueDate, setLtDueDate] = useState("");
  const [ltPriority, setLtPriority] = useState("normal");
  const [ltSaving, setLtSaving] = useState(false);
  const [ltExpandedId, setLtExpandedId] = useState(null);
  const [ltSortAsc, setLtSortAsc] = useState(true);   // Tasks tab: oldest-due first
  const [infoNotesSortAsc, setInfoNotesSortAsc] = useState(true); // Info tab: oldest note first

  // Info tab progress note state — must be at component top level (hooks rule)
  const [infoNoteText, setInfoNoteText] = useState("");
  const [infoNoteChannel, setInfoNoteChannel] = useState("Note");
  const [infoNoteTyping, setInfoNoteTyping] = useState(false);
  const [infoNoteSaving, setInfoNoteSaving] = useState(false);

  // Typed confirm dialog — replaces window.confirm() for archive action
  const { confirmEl: leadConfirmEl, confirm: leadConfirm } = useConfirm();

  const saveInfo = async () => {
    setSavingInfo(true);
    try {
      const newDealName = draft.deal_name.trim() || `${draft.commodity} · ${draft.location}`.trim() || deal.deal_name;
      const updates = {
        deal_name:   newDealName,
        commodity:   draft.commodity,
        lead_side:   draft.lead_side,
        location:    draft.location,
        description: draft.description,
        heat:        draft.heat,
        updated_at:  nowISO(),
      };
      await sb.update("deals", deal.id, updates);
      dispatch({ type:"UPDATE_DEAL", id:deal.id, updates });

      // Also update any lead tasks' titles to match the new deal name
      const linkedTasks = Object.values(state.tasks).filter(
        t => t.card_id === deal.id && t.card_type === "lead" && t.status !== "completed" && t.status !== "archived"
      );
      for (const lt of linkedTasks) {
        const taskUpdates = { title: newDealName, description: draft.description };
        await sb.update("tasks", lt.id, taskUpdates);
        dispatch({ type:"UPDATE_TASK", id:lt.id, updates:taskUpdates });
      }

      setEditing(false);
    } catch(e) { console.error(e); } finally { setSavingInfo(false); }
  };

  const addLeadTask = async () => {
    if (!ltTitle.trim()) return;
    setLtSaving(true);
    try {
      const task = {
        id: genId(), title: ltTitle.trim(), description: ltDescription.trim(),
        due_date: ltDueDate || null, priority: ltPriority, status: "not_started",
        card_id: deal.id, card_type: "lead", subtasks: [], created_at: nowISO(),
      };
      await sb.insert("tasks", task);
      dispatch({ type:"ADD_TASK", task });
      await logTaskEvent(dispatch, task, "task_created");
      setLtTitle(""); setLtDescription(""); setLtDueDate(""); setLtPriority("normal");
    } catch(e) { console.error(e); } finally { setLtSaving(false); }
  };

  const toggleLeadTask = async (task) => {
    const newStatus = task.status === "completed" ? "not_started" : "completed";
    const updates = { status: newStatus, completed_at: newStatus === "completed" ? nowISO() : null };
    try {
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
    } catch(e) { console.error(e); }
  };

  const deleteLeadTask = async (id) => {
    try {
      await sb.delete("tasks", id);
      dispatch({ type:"DELETE_TASK", id });
      if (ltExpandedId === id) setLtExpandedId(null);
    } catch(e) { console.error(e); }
  };

  const inputStyle = { width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:8, padding:"7px 10px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, boxSizing:"border-box" };

  return (
    <div style={{ width:360, borderLeft:`0.5px solid ${C.border}`, display:"flex", flexDirection:"column", height:"100%", background:C.bg, flexShrink:0 }}>
      {/* Header */}
      {/* Orange top band — title only */}
      <div style={{ background:C.orange, padding:"8px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, flex:1, minWidth:0 }}>
          <span style={{ fontSize:10, fontWeight:600, color:"#fff", textTransform:"uppercase", letterSpacing:"0.05em", flexShrink:0 }}>Lead</span>
          <span style={{ fontSize:13, fontWeight:500, color:"#fff", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {deal.deal_name || [deal.commodity, deal.location].filter(Boolean).join(" · ") || "New lead"}
          </span>
        </div>
        <span onClick={onClose} style={{ cursor:"pointer", fontSize:18, color:"rgba(255,255,255,0.8)", flexShrink:0, lineHeight:1 }}>×</span>
      </div>
      {/* White sub-header — pills + tabs */}
      <div style={{ borderBottom:`0.5px solid ${C.border}`, background:C.bg, flexShrink:0 }}>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center", padding:"8px 14px 6px" }}>
          {deal.commodity && <CommodityPill commodity={deal.commodity} />}
          {deal.lead_side && <Pill style={{ background:C.orangeLight, color:C.orangeDark, borderColor:C.orangeBorder }}>{deal.lead_side}</Pill>}
          {deal.heat && deal.heat !== "0" && <span style={{ fontSize:13 }}>{HEAT_FLAMES[deal.heat]}</span>}
          <span style={{ fontSize:10, color:C.textMuted }}>Added {fmtRelDate(deal.created_at)}</span>
        </div>
        <div style={{ display:"flex", borderTop:`0.5px solid ${C.border}` }}>
          {["Info","Tasks"].map(t => (
            <span key={t} onClick={() => setTab(t.toLowerCase())} style={{
              flex:1, textAlign:"center", padding:"7px 4px", fontSize:11, fontWeight:500,
              color: tab===t.toLowerCase() ? C.orange : C.textMuted,
              borderBottom: tab===t.toLowerCase() ? `2px solid ${C.orange}` : "2px solid transparent",
              cursor:"pointer", userSelect:"none"
            }}>{t}</span>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex:1, overflowY:"auto" }}>
        {tab === "info" && (
          <div style={{ padding:16, display:"flex", flexDirection:"column", gap:14 }}>
            {!editing ? (
              <>
                {/* Static fields */}
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                  {[
                    { label:"Commodity", value:deal.commodity },
                    { label:"Side",      value:deal.lead_side },
                    { label:"Deal name", value:deal.deal_name || deal.location },
                    { label:"Added",     value:fmtDate(deal.created_at) },
                  ].map(f => f.value ? (
                    <div key={f.label}>
                      <div style={{ fontSize:10, color:C.textMuted, marginBottom:2 }}>{f.label}</div>
                      <div style={{ fontSize:13, color:C.text }}>{f.value}</div>
                    </div>
                  ) : null)}
                </div>
                {deal.description && (
                  <div>
                    <div style={{ fontSize:10, color:C.textMuted, marginBottom:4 }}>Note</div>
                    <div style={{ fontSize:12, color:C.textMuted, lineHeight:1.6, whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{deal.description}</div>
                  </div>
                )}

                {/* Progress notes thread — collects from deal directly and all linked tasks */}
                {(() => {
                  const linkedTasks = Object.values(state.tasks).filter(t => t.card_id === deal.id);
                  const linkedTaskIds = new Set(linkedTasks.map(t => t.id));
                  const linkedTaskMap = Object.fromEntries(linkedTasks.map(t => [t.id, t]));
                  const dealNotes = Object.values(state.threads || {})
                    .filter(e => !e.is_system_event && (
                      (e.card_id === deal.id) ||
                      (linkedTaskIds.has(e.card_id) && e.card_type === "task")
                    ))
                    .sort((a,b) => infoNotesSortAsc
                      ? new Date(a.created_at) - new Date(b.created_at)
                      : new Date(b.created_at) - new Date(a.created_at));
                  return dealNotes.length > 0 ? (
                    <div>
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
                        <SectionLabel style={{ margin:0 }}>Progress notes</SectionLabel>
                        <span onClick={() => setInfoNotesSortAsc(v => !v)} style={{
                          fontSize:9, color:C.textMuted, cursor:"pointer", userSelect:"none",
                          display:"inline-flex", alignItems:"center", gap:3,
                          border:`0.5px solid ${C.border}`, borderRadius:4, padding:"1px 6px",
                          background:C.bgSecondary
                        }}>
                          {infoNotesSortAsc ? "↑ Oldest first" : "↓ Newest first"}
                        </span>
                      </div>
                      <div style={{ display:"flex", flexDirection:"column" }}>
                        {dealNotes.map((note, idx) => {
                          const col = CH_COLOUR[note.channel];
                          const icon = CH_ICON[note.channel];
                          const isLast = idx === dealNotes.length - 1;
                          const sourceTask = note.card_type === "task" ? linkedTaskMap[note.card_id] : null;
                          return (
                            <div key={note.id} style={{ display:"flex", gap:8, alignItems:"flex-start",
                              padding:"7px 0", borderBottom: isLast ? "none" : `0.5px solid ${C.border}` }}>
                              {icon ? (
                                <div style={{ width:18, height:18, borderRadius:"50%", flexShrink:0,
                                  background:col?.bg, border:`0.5px solid ${col?.border}`,
                                  display:"flex", alignItems:"center", justifyContent:"center", marginTop:1 }}>
                                  <i className={`ti ${icon}`} style={{ fontSize:9, color:col?.text }} />
                                </div>
                              ) : (
                                <div style={{ width:8, height:8, borderRadius:"50%",
                                  background:C.tealBorder, flexShrink:0, marginTop:5 }} />
                              )}
                              <div style={{ flex:1 }}>
                                <div style={{ fontSize:9, color:C.textDim, marginBottom:2 }}>
                                  {fmtDate(note.created_at)} · {fmtTime(note.created_at)}
                                  {sourceTask && (
                                    <span onClick={() => { setTab("tasks"); setLtExpandedId(sourceTask.id); }}
                                      title="Jump to task"
                                      style={{ marginLeft:5, color:C.orangeDark,
                                        background:C.orangeLight, border:`0.5px solid ${C.orangeBorder}`,
                                        borderRadius:4, padding:"0px 5px", fontSize:9, cursor:"pointer" }}>
                                      ↗ {sourceTask.title}
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize:11, color:C.text, lineHeight:1.5 }}>{note.text}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null;
                })()}

                {/* Add progress note */}
                {(() => {
                  const saveInfoNote = async () => {
                    if (!infoNoteText.trim()) return;
                    setInfoNoteSaving(true);
                    try {
                      const entry = {
                        id: genId(), card_id: deal.id, card_type: "lead",
                        channel: infoNoteChannel, text: infoNoteText.trim(),
                        is_system_event: false, created_at: nowISO()
                      };
                      await sb.insert("thread_entries", entry);
                      dispatch({ type:"ADD_THREAD", entry });
                      setInfoNoteText(""); setInfoNoteChannel("Note"); setInfoNoteTyping(false);
                    } catch(e) { console.error(e); }
                    setInfoNoteSaving(false);
                  };
                  return (
                    <div>
                      <textarea
                        dir="ltr"
                        value={infoNoteText}
                        onChange={e => {
                          setInfoNoteText(e.target.value);
                          if (e.target.value.length > 0 && !infoNoteTyping) setInfoNoteTyping(true);
                          if (e.target.value.length === 0) { setInfoNoteTyping(false); setInfoNoteChannel("Note"); }
                        }}
                        placeholder="Add a progress note… e.g. Called today, waiting on response"
                        rows={2}
                        onKeyDown={e => { if (e.key === "Enter" && e.metaKey) saveInfoNote(); }}
                        style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:7,
                          padding:"7px 9px", fontSize:11, fontFamily:"system-ui,sans-serif",
                          resize:"none", outline:"none", color:C.text, lineHeight:1.5 }}
                      />
                      <div style={{
                        display:"flex", alignItems:"center", gap:6, marginTop:5,
                        maxHeight: infoNoteTyping ? 32 : 0, opacity: infoNoteTyping ? 1 : 0,
                        overflow:"hidden", transition:"max-height 0.18s ease, opacity 0.15s ease"
                      }}>
                        <span style={{ fontSize:9, color:C.textDim, flexShrink:0 }}>Type:</span>
                        {CHANNELS.map(ch => {
                          const col = CH_COLOUR[ch];
                          const isActive = infoNoteChannel === ch;
                          return (
                            <span key={ch} onClick={() => setInfoNoteChannel(ch)} title={ch} style={{
                              width:22, height:22, borderRadius:"50%",
                              background: isActive ? col.border : col.bg,
                              border:`1px solid ${isActive ? col.text : col.border}`,
                              display:"inline-flex", alignItems:"center", justifyContent:"center",
                              cursor:"pointer", flexShrink:0,
                              boxShadow: isActive ? `0 0 0 2px ${col.border}` : "none"
                            }}>
                              <i className={`ti ${CH_ICON[ch]}`} style={{ fontSize:10, color:col.text, opacity: isActive ? 1 : 0.55 }} />
                            </span>
                          );
                        })}
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:5 }}>
                        <span style={{ fontSize:9, color:C.textDim }}>⌘ + Enter to save</span>
                        <Btn variant="teal" onClick={saveInfoNote} style={{ fontSize:10, padding:"3px 10px" }}>
                          {infoNoteSaving ? "Saving…" : "Add note"}
                        </Btn>
                      </div>
                    </div>
                  );
                })()}

                {/* Card action icon strip */}
                <div style={{ display:"flex", alignItems:"center", gap:5, paddingTop:10, borderTop:`0.5px solid ${C.border}` }}>
                  {/* Edit */}
                  <span onClick={() => { setDraft({ deal_name:deal.deal_name||"", commodity:deal.commodity||"", lead_side:deal.lead_side||"Buyer", location:deal.location||"", description:deal.description||"", heat:deal.heat||"0" }); setEditing(true); }}
                    title="Edit card details" style={{
                      width:28, height:28, borderRadius:7, border:`0.5px solid ${C.borderMid}`,
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      cursor:"pointer", color:C.textMuted, fontSize:15
                    }}>
                    <i className="ti ti-pencil" aria-hidden="true" />
                  </span>
                  <div style={{ width:"0.5px", height:14, background:C.borderMid, margin:"0 2px" }} />
                  {/* Archive */}
                  <span onClick={async () => {
                    if (!await leadConfirm("Archive this lead?")) return;
                    setActioning(true);
                    try {
                      await sb.update("deals", deal.id, { archived:true, updated_at:nowISO() });
                      dispatch({ type:"UPDATE_DEAL", id:deal.id, updates:{ archived:true } });
                      onClose();
                    } catch(e){ console.error(e); } finally { setActioning(false); }
                  }} title="Archive" style={{
                    width:28, height:28, borderRadius:7, border:`0.5px solid ${C.borderMid}`,
                    display:"inline-flex", alignItems:"center", justifyContent:"center",
                    cursor:"pointer", color:C.textMuted, fontSize:15, opacity:actioning?0.5:1
                  }}>
                    <i className="ti ti-archive" aria-hidden="true" />
                  </span>
                  {/* Close lead */}
                  <span onClick={() => setShowCloseResolutionPrompt(true)}
                    title="Close lead" style={{
                      width:28, height:28, borderRadius:7, border:`0.5px solid ${C.borderMid}`,
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      cursor:"pointer", color:C.textMuted, fontSize:15
                    }}>
                    <i className="ti ti-circle-x" aria-hidden="true" />
                  </span>
                  <div style={{ width:"0.5px", height:14, background:C.borderMid, margin:"0 2px" }} />
                  {/* Delete */}
                  <span onClick={() => setShowDeleteConfirm(true)}
                    title="Delete permanently" style={{
                      width:28, height:28, borderRadius:7, border:`0.5px solid ${C.redBorder}`,
                      background:C.redLight, display:"inline-flex", alignItems:"center",
                      justifyContent:"center", cursor:"pointer", color:C.red, fontSize:15
                    }}>
                    <i className="ti ti-trash" aria-hidden="true" />
                  </span>
                  {/* Task registry link — navigation, not an action */}
                  <span onClick={() => onNavigateToTasks && onNavigateToTasks(deal.id)}
                    title="View in task registry"
                    style={{ marginLeft:"auto", display:"inline-flex", alignItems:"center", gap:4,
                      fontSize:10, color:C.textMuted, cursor:"pointer", padding:"3px 0" }}>
                    <i className="ti ti-list" style={{ fontSize:12 }} aria-hidden="true" />
                    Task registry
                  </span>
                </div>

                {/* Close lead resolution prompt */}
                {showCloseResolutionPrompt && (
                  <div style={{ background:C.greenLight, border:`0.5px solid ${C.greenBorder}`, borderRadius:8, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8 }}>
                    <div style={{ fontSize:11, fontWeight:500, color:C.green }}>How was this lead resolved? <span style={{ fontWeight:400, color:C.textMuted }}>(optional)</span></div>
                    <textarea autoFocus value={closeResolutionText} onChange={e => setCloseResolutionText(e.target.value)}
                      placeholder="e.g. Buyer went with another supplier on price"
                      rows={3}
                      style={{ width:"100%", border:`0.5px solid ${C.greenBorder}`, borderRadius:6, padding:"7px 9px", fontSize:11, fontFamily:"inherit", resize:"none", color:C.text, outline:"none", lineHeight:1.5 }} />
                    <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
                      <span onClick={() => { setShowCloseResolutionPrompt(false); setCloseResolutionText(""); }} style={{ fontSize:11, fontWeight:500, borderRadius:999, padding:"4px 12px", border:`0.5px solid ${C.border}`, color:C.textMuted, cursor:"pointer" }}>Cancel</span>
                      <span onClick={async () => {
                        setActioning(true);
                        try {
                          const updates = { state:"closed_lost", resolution: closeResolutionText.trim() || null, updated_at:nowISO() };
                          await sb.update("deals", deal.id, updates);
                          dispatch({ type:"UPDATE_DEAL", id:deal.id, updates });
                          setShowCloseResolutionPrompt(false);
                          onClose();
                        } catch(e){ console.error(e); } finally { setActioning(false); }
                      }} style={{ fontSize:11, fontWeight:500, borderRadius:999, padding:"5px 14px", background:C.green, color:"#fff", border:`0.5px solid ${C.green}`, cursor:"pointer", opacity:actioning?0.5:1 }}>
                        {actioning ? "Closing…" : "Close lead"}
                      </span>
                    </div>
                  </div>
                )}

                {/* Delete confirm */}
                {showDeleteConfirm && (
                  <div style={{ background:C.redLight, borderRadius:8, padding:"10px 12px", border:`0.5px solid ${C.redBorder}` }}>
                    <div style={{ fontSize:11, color:C.red, marginBottom:8, fontWeight:500 }}>Delete this lead permanently?</div>
                    <div style={{ display:"flex", gap:8 }}>
                      <span onClick={() => setShowDeleteConfirm(false)} style={{ fontSize:11, fontWeight:500, borderRadius:999, padding:"4px 12px", border:`0.5px solid ${C.border}`, color:C.textMuted, cursor:"pointer" }}>Cancel</span>
                      <span onClick={async () => {
                        setActioning(true);
                        try {
                          await sb.delete("deals", deal.id);
                          dispatch({ type:"DELETE_DEAL", id:deal.id });
                          onClose();
                        } catch(e){ console.error(e); } finally { setActioning(false); }
                      }} style={{ fontSize:11, fontWeight:500, borderRadius:999, padding:"4px 12px", background:C.red, color:"#fff", border:`0.5px solid ${C.red}`, cursor:"pointer", opacity:actioning?0.5:1 }}>
                        Yes, delete
                      </span>
                    </div>
                  </div>
                )}

                {/* Qualify — bottom */}
                <div style={{ background:C.orangeLight, borderRadius:8, padding:"10px 14px",
                  border:`0.5px solid ${C.orangeBorder}`, display:"flex", alignItems:"center",
                  justifyContent:"space-between" }}>
                  <span style={{ fontSize:11, color:C.orangeDark, fontWeight:500 }}>Ready to qualify?</span>
                  <span onClick={() => setShowQualify(true)} style={{
                    fontSize:11, fontWeight:500, borderRadius:999, padding:"4px 12px",
                    background:"transparent", color:C.orangeDark, border:`0.5px solid ${C.orangeBorder}`, cursor:"pointer"
                  }}>Qualify → create deal</span>
                </div>
              </>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                <div>
                  <div style={{ fontSize:10, color:C.textMuted, marginBottom:4 }}>Deal name</div>
                  <input value={draft.deal_name} onChange={e => setDraft(d => ({...d, deal_name:e.target.value}))}
                    placeholder="e.g. Gold Doré · Dubai" style={inputStyle} autoFocus />
                </div>
                <div>
                  <div style={{ fontSize:10, color:C.textMuted, marginBottom:6 }}>Commodity</div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    {COMMODITIES.map(c => (
                      <span key={c} onClick={() => setDraft(d => ({...d, commodity:c}))} style={{
                        fontSize:11, fontWeight:500, borderRadius:999, padding:"3px 11px",
                        border:`0.5px solid ${draft.commodity===c ? C.orangeBorder : C.borderMid}`,
                        background: draft.commodity===c ? C.orangeLight : C.bg,
                        color: draft.commodity===c ? C.orangeDark : C.textMuted, cursor:"pointer"
                      }}>{c}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:10, color:C.textMuted, marginBottom:6 }}>Side</div>
                  <div style={{ display:"flex", gap:6 }}>
                    {["Buyer","Seller"].map(s => (
                      <span key={s} onClick={() => setDraft(d => ({...d, lead_side:s}))} style={{
                        fontSize:11, fontWeight:500, borderRadius:999, padding:"3px 14px",
                        border:`0.5px solid ${draft.lead_side===s ? C.orangeBorder : C.borderMid}`,
                        background: draft.lead_side===s ? C.orangeLight : C.bg,
                        color: draft.lead_side===s ? C.orangeDark : C.textMuted, cursor:"pointer"
                      }}>{s}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:10, color:C.textMuted, marginBottom:6 }}>Heat</div>
                  <div style={{ display:"flex", gap:6 }}>
                    {["0","1","2","3"].map(h => (
                      <span key={h} onClick={() => setDraft(d => ({...d, heat:h}))} style={{
                        fontSize:13, borderRadius:999, padding:"3px 12px", minWidth:40, textAlign:"center",
                        border:`0.5px solid ${draft.heat===h ? C.orangeBorder : C.borderMid}`,
                        background: draft.heat===h ? C.orangeLight : C.bg,
                        cursor:"pointer"
                      }}>{HEAT_FLAMES[h] || "None"}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:10, color:C.textMuted, marginBottom:4 }}>Location</div>
                  <input value={draft.location} onChange={e => setDraft(d => ({...d, location:e.target.value}))} style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize:10, color:C.textMuted, marginBottom:4 }}>Note</div>
                  <textarea value={draft.description} onChange={e => setDraft(d => ({...d, description:e.target.value}))} rows={4}
                    style={{ ...inputStyle, resize:"vertical", lineHeight:1.5 }} />
                </div>
                <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
                  <span onClick={() => setEditing(false)} style={{ fontSize:12, fontWeight:500, borderRadius:999, padding:"5px 14px", border:`0.5px solid ${C.border}`, color:C.textMuted, cursor:"pointer" }}>Cancel</span>
                  <span onClick={saveInfo} style={{
                    fontSize:12, fontWeight:500, borderRadius:999, padding:"5px 14px",
                    background:C.orangeLight, color:C.orangeDark, border:`0.5px solid ${C.orangeBorder}`,
                    cursor:"pointer", opacity:savingInfo?0.6:1
                  }}>{savingInfo ? "Saving…" : "Save"}</span>
                </div>
              </div>
            )}
          </div>
        )}
        {tab === "tasks" && (() => {
          const allTasks = Object.values(state.tasks)
            .filter(t => t.card_id === deal.id && t.status !== "archived");
          const dateSortFn = (a,b) => ltSortAsc
            ? new Date(a.due_date||"9999") - new Date(b.due_date||"9999")
            : new Date(b.due_date||"0") - new Date(a.due_date||"0");
          const overdueTasks  = allTasks.filter(t => t.status !== "completed" && isOverdue(t.due_date)).sort(dateSortFn);
          const todayTasks    = allTasks.filter(t => t.status !== "completed" && isToday(t.due_date));
          const upcomingTasks = allTasks.filter(t => t.status !== "completed" && t.due_date && !isOverdue(t.due_date) && !isToday(t.due_date)).sort(dateSortFn);
          const undatedTasks  = allTasks.filter(t => t.status !== "completed" && !t.due_date);
          const completedTasks= allTasks.filter(t => t.status === "completed")
            .sort((a,b) => new Date(b.completed_at||b.created_at) - new Date(a.completed_at||a.created_at));

          const ltInputStyle = { width:"100%", border:`0.5px solid ${C.orangeBorder}`, borderRadius:6, padding:"6px 8px", fontSize:11, fontFamily:"inherit", outline:"none", background:"white", color:C.text };

          const SectionGroup = ({ label, colour, tasks }) => tasks.length === 0 ? null : (
            <div>
              <div style={{ fontSize:9, fontWeight:600, textTransform:"uppercase", letterSpacing:".06em",
                color: colour || C.textMuted, padding:"5px 0 4px",
                borderBottom:`0.5px solid ${C.border}`, marginBottom:0 }}>{label}</div>
              {tasks.map(task => (
                <DealTaskRow key={task.id} task={task}
                  state={state} dealId={deal.id}
                  expanded={ltExpandedId === task.id}
                  onToggleExpand={() => setLtExpandedId(ltExpandedId === task.id ? null : task.id)}
                  onToggleComplete={() => toggleLeadTask(task)}
                  onDelete={() => deleteLeadTask(task.id)}
                  dispatch={dispatch}
                />
              ))}
            </div>
          );

          return (
            <div style={{ padding:14, display:"flex", flexDirection:"column", gap:12 }}>
              {/* Add task form */}
              <div style={{ background:C.orangeLight, borderRadius:8, padding:10, border:`0.5px solid ${C.orangeBorder}` }}>
                <SectionLabel>New task</SectionLabel>
                <input placeholder="Task title…" value={ltTitle} onChange={e => setLtTitle(e.target.value)}
                  style={{ ...ltInputStyle, marginBottom:7 }}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) addLeadTask(); }} />
                <textarea dir="ltr" placeholder="Description (optional)…" value={ltDescription} onChange={e => setLtDescription(e.target.value)} rows={2}
                  style={{ ...ltInputStyle, marginBottom:7, resize:"none" }} />
                <div style={{ display:"flex", gap:6, marginBottom:7 }}>
                  <input type="date" value={ltDueDate} onChange={e => setLtDueDate(e.target.value)}
                    style={{ flex:1, border:`0.5px solid ${C.orangeBorder}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", background:"white", color:C.text }} />
                  <select value={ltPriority} onChange={e => setLtPriority(e.target.value)}
                    style={{ flex:1, border:`0.5px solid ${C.orangeBorder}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", background:"white", color:C.text, appearance:"none" }}>
                    {PRIORITIES.map(p => <option key={p} value={p}>{PRI_WORD[p]}</option>)}
                  </select>
                </div>
                <div style={{ display:"flex", justifyContent:"flex-end" }}>
                  <span onClick={addLeadTask} style={{
                    fontSize:11, fontWeight:500, borderRadius:999, padding:"4px 14px",
                    background:C.orange, color:"#fff", border:`0.5px solid ${C.orange}`,
                    cursor:"pointer", opacity: ltSaving ? 0.6 : 1
                  }}>{ltSaving ? "Saving…" : "Save task"}</span>
                </div>
              </div>

              {/* Task sections */}
              {allTasks.filter(t => t.status !== "completed").length === 0 && completedTasks.length === 0 ? (
                <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No tasks for this lead yet</div>
              ) : (
                <>
                  <div style={{ display:"flex", justifyContent:"flex-end" }}>
                    <span onClick={() => setLtSortAsc(v => !v)} style={{
                      fontSize:9, color:C.textMuted, cursor:"pointer", userSelect:"none",
                      display:"inline-flex", alignItems:"center", gap:3,
                      border:`0.5px solid ${C.border}`, borderRadius:4, padding:"1px 6px",
                      background:C.bgSecondary
                    }}>
                      {ltSortAsc ? "↑ Oldest due first" : "↓ Newest due first"}
                    </span>
                  </div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  <SectionGroup label="⚠ Overdue" colour={C.red} tasks={overdueTasks} />
                  <SectionGroup label="Today" colour={C.green} tasks={todayTasks} />
                  <SectionGroup label="Upcoming" tasks={upcomingTasks} />
                  <SectionGroup label="No date" tasks={undatedTasks} />
                  {completedTasks.length > 0 && (
                    <div style={{ opacity:0.55 }}>
                      <SectionGroup label="Completed" tasks={completedTasks} />
                    </div>
                  )}
                </div>
                </>
              )}
            </div>
          );
        })()}
      </div>
      {leadConfirmEl}
      {showQualify && (
        <QualifyWizard deal={deal} state={state} dispatch={dispatch} onClose={() => setShowQualify(false)} onDone={(dealId) => { onClose(); onQualified && onQualified(dealId || deal.id); }} />
      )}
    </div>
  );
}

// ── QUALIFY WIZARD ──
function QualifyWizard({ deal, state, dispatch, onClose, onDone }) {
  const [step, setStep] = useState(1);
  const [buyerSearch, setBuyerSearch] = useState("");
  const [selectedBuyer, setSelectedBuyer] = useState(null);
  const [createNewBuyer, setCreateNewBuyer] = useState(false);
  const [newBuyerName, setNewBuyerName] = useState("");
  const [instrument, setInstrument] = useState(deal.instrument || "CIF");
  const [dealName, setDealName] = useState("");
  const [saving, setSaving] = useState(false);

  const buyers = Object.values(state.buyers);
  const filteredBuyers = buyerSearch
    ? buyers.filter(b => (b.company_name || b.name || "").toLowerCase().includes(buyerSearch.toLowerCase()))
    : buyers;
  const buyerDisplay = selectedBuyer ? (selectedBuyer.company_name || selectedBuyer.name) : newBuyerName;

  const handleFinish = async () => {
    if (!buyerDisplay) return;
    setSaving(true);
    try {
      let buyerId = selectedBuyer?.id;
      let buyerName = buyerDisplay;
      if (createNewBuyer && newBuyerName.trim()) {
        const nb = {
          id:genId(), first_name:"", last_name:"", company_name:newBuyerName.trim(),
          name:newBuyerName.trim(), phone:"", email:"", location:deal.location||"",
          relationship_type:"direct", instruments:[], commodities:[], min_qty:"", max_qty:"",
          rating:0, status:"active", mandate:"", intermediary:"", notes:"", avatar_url:"",
          created_at:nowISO()
        };
        await sb.insert("buyers", nb);
        dispatch({ type:"ADD_BUYER", buyer:nb });
        buyerId = nb.id; buyerName = nb.company_name;
      }
      const newDealName = dealName.trim() || `${buyerName} — ${instrument}`;
      const updates = {
        state:"potential", buyer_id:buyerId||null, buyer_name:buyerName,
        instrument, deal_name:newDealName,
        lead_side:null,
      };
      await sb.update("deals", deal.id, updates);
      dispatch({ type:"UPDATE_DEAL", id:deal.id, updates });

      // Migrate all tasks linked to this lead: update card_type from
      // "lead" to "deal" so the task registry no longer treats them as
      // lead tasks, and navigation links go to the correct board tab.
      // Also update the task title if it matches the old deal name
      // (the lead task was auto-named from the lead name at creation).
      // (v9.3.69)
      const linkedTasks = Object.values(state.tasks).filter(
        t => t.card_id === deal.id && t.card_type === "lead"
      );
      for (const t of linkedTasks) {
        const taskUpdates = {
          card_type: "deal",
          // Rename the task if its title is the old deal name —
          // keeps task titles in sync with the promoted deal name
          ...(t.title === deal.deal_name ? { title: newDealName } : {}),
        };
        await sb.update("tasks", t.id, taskUpdates);
        dispatch({ type:"UPDATE_TASK", id:t.id, updates:taskUpdates });
      }

      onDone(deal.id);
    } catch(e) { console.error(e); } finally { setSaving(false); }
  };

  const inputStyle = { width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:8, padding:"7px 10px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, boxSizing:"border-box" };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:1100, display:"flex", alignItems:"center", justifyContent:"center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background:C.bg, borderRadius:12, width:420, overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ padding:"14px 20px", borderBottom:`0.5px solid ${C.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontSize:14, fontWeight:500, color:C.text }}>Qualify lead</div>
            <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>Step {step} of 3 — {step===1?"Buyer":step===2?"Instrument":"Confirm"}</div>
          </div>
          <span onClick={onClose} style={{ cursor:"pointer", fontSize:18, color:C.textMuted }}>×</span>
        </div>
        <div style={{ padding:"16px 20px", minHeight:200 }}>
          {step===1 && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <SectionLabel>Who is the buyer?</SectionLabel>
              {!selectedBuyer && !createNewBuyer ? (
                <div>
                  <input placeholder="Search buyer registry…" value={buyerSearch} onChange={e => setBuyerSearch(e.target.value)} style={inputStyle} autoFocus />
                  {buyerSearch && (
                    <div style={{ border:`0.5px solid ${C.border}`, borderRadius:8, marginTop:4, maxHeight:160, overflowY:"auto" }}>
                      {filteredBuyers.length>0 ? filteredBuyers.map(b => (
                        <div key={b.id} onClick={() => { setSelectedBuyer(b); setDealName(`${b.company_name||b.name} — ${instrument}`); }}
                          style={{ padding:"8px 12px", fontSize:12, cursor:"pointer", borderBottom:`0.5px solid ${C.border}`, color:C.text }}
                          onMouseEnter={e => e.currentTarget.style.background=C.bgSecondary}
                          onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                          <div style={{ fontWeight:500 }}>{b.company_name||b.name}</div>
                          {b.location && <div style={{ fontSize:10, color:C.textMuted }}>{b.location}</div>}
                        </div>
                      )) : (
                        <div>
                          <div style={{ padding:"8px 12px", fontSize:11, color:C.textMuted }}>No match found</div>
                          <div onClick={() => { setCreateNewBuyer(true); setNewBuyerName(buyerSearch); }}
                            style={{ padding:"8px 12px", fontSize:11, color:C.tealText, cursor:"pointer", borderTop:`0.5px solid ${C.border}`, fontWeight:500 }}>
                            + Create buyer: "{buyerSearch}"
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 10px", background:C.tealLight, borderRadius:8, border:`0.5px solid ${C.tealBorder}` }}>
                  <div style={{ fontSize:12, fontWeight:500, color:C.tealText }}>{buyerDisplay}</div>
                  <span onClick={() => { setSelectedBuyer(null); setCreateNewBuyer(false); setNewBuyerName(""); setBuyerSearch(""); }} style={{ fontSize:16, cursor:"pointer", color:C.tealText }}>×</span>
                </div>
              )}
            </div>
          )}
          {step===2 && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <SectionLabel>Instrument</SectionLabel>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {INSTRUMENTS.map(i => (
                  <span key={i} onClick={() => { setInstrument(i); setDealName(`${buyerDisplay} — ${i}`); }} style={{
                    fontSize:11, fontWeight:500, borderRadius:999, padding:"3px 11px",
                    border:`0.5px solid ${instrument===i ? C.tealBorder : C.borderMid}`,
                    background: instrument===i ? C.tealLight : C.bg,
                    color: instrument===i ? C.tealText : C.textMuted, cursor:"pointer"
                  }}>{i}</span>
                ))}
              </div>
            </div>
          )}
          {step===3 && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <SectionLabel>Deal name</SectionLabel>
              <input value={dealName||`${buyerDisplay} — ${instrument}`} onChange={e => setDealName(e.target.value)} style={inputStyle} autoFocus />
              <div style={{ fontSize:11, color:C.textMuted, lineHeight:1.6 }}>
                Commodity: <strong>{deal.commodity}</strong> · Country: <strong>{deal.location}</strong><br/>
                Note will carry across to the deal description.
              </div>
            </div>
          )}
        </div>
        <div style={{ padding:"12px 20px", borderTop:`0.5px solid ${C.border}`, display:"flex", justifyContent:"space-between" }}>
          {step>1
            ? <span onClick={() => setStep(s=>s-1)} style={{ fontSize:12, fontWeight:500, borderRadius:999, padding:"5px 14px", border:`0.5px solid ${C.border}`, color:C.textMuted, cursor:"pointer" }}>← Back</span>
            : <span />}
          {step<3
            ? <span onClick={() => buyerDisplay && setStep(s=>s+1)} style={{
                fontSize:12, fontWeight:500, borderRadius:999, padding:"5px 14px",
                background:buyerDisplay?C.tealLight:C.bgSecondary, color:buyerDisplay?C.tealText:C.textDim,
                border:`0.5px solid ${buyerDisplay?C.tealBorder:C.border}`,
                cursor:buyerDisplay?"pointer":"not-allowed"
              }}>Next →</span>
            : <span onClick={handleFinish} style={{
                fontSize:12, fontWeight:500, borderRadius:999, padding:"5px 14px",
                background:C.tealLight, color:C.tealText, border:`0.5px solid ${C.tealBorder}`,
                cursor:"pointer", opacity:saving?0.6:1
              }}>{saving?"Saving…":"Create deal"}</span>}
        </div>
      </div>
    </div>
  );
}

// ── ADD DEAL MODAL ──
function AddDealModal({ state, dispatch, onClose, onCreated }) {
  const [buyerSearch, setBuyerSearch] = useState("");
  const [selectedBuyer, setSelectedBuyer] = useState(null);
  const [createNewBuyer, setCreateNewBuyer] = useState(false);
  const [newBuyerName, setNewBuyerName] = useState("");
  const [instrument, setInstrument] = useState("CIF");
  const [commodity, setCommodity] = useState("Gold Doré");
  const [dealName, setDealName] = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  const buyers = Object.values(state.buyers);
  const filteredBuyers = buyerSearch
    ? buyers.filter(b => (b.company_name || b.name || "").toLowerCase().includes(buyerSearch.toLowerCase()))
    : buyers;

  // Auto-regenerate deal name whenever buyer or instrument changes
  // unless the user has manually edited the name field
  const buyerLabel = selectedBuyer
    ? (selectedBuyer.company_name || selectedBuyer.name)
    : (createNewBuyer ? newBuyerName : "");

  useEffect(() => {
    if (!nameManuallyEdited && buyerLabel) {
      setDealName(`${buyerLabel} — ${instrument}`);
    }
  }, [buyerLabel, instrument, nameManuallyEdited]);

  const handleBuyerSelect = (b) => {
    setSelectedBuyer(b);
    setBuyerSearch("");
    setNameManuallyEdited(false); // reset so name auto-generates from new buyer
  };

  const handleInstrumentChange = (val) => {
    setInstrument(val);
    // If name hasn't been manually edited, it will auto-update via useEffect
  };

  const handleNameChange = (val) => {
    setDealName(val);
    setNameManuallyEdited(true);
  };

  const validate = () => {
    const errs = {};
    if (!selectedBuyer && !createNewBuyer) errs.buyer = "Please select or create a buyer.";
    if (!instrument) errs.instrument = "Instrument is required.";
    if (!commodity) errs.commodity = "Commodity is required.";
    if (!dealName.trim()) errs.dealName = "Deal name is required.";
    return errs;
  };

  const handleSave = async () => {
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setSaving(true);
    try {
      let buyerId = selectedBuyer?.id;
      let buyerName = selectedBuyer?.company_name || selectedBuyer?.name || "";

      if (createNewBuyer && newBuyerName.trim()) {
        const nb = {
          id: genId(), first_name:"", last_name:"", company_name: newBuyerName.trim(),
          name: newBuyerName.trim(), phone:"", email:"", location:"", relationship_type:"direct",
          instruments:[], commodities:[], min_qty:"", max_qty:"", rating:0,
          status:"active", mandate:"", intermediary:"", notes:"", avatar_url:"",
          created_at: nowISO()
        };
        await sb.insert("buyers", nb);
        dispatch({ type:"ADD_BUYER", buyer:nb });
        buyerId = nb.id;
        buyerName = nb.company_name;
      }

      const deal = {
        id: genId(),
        deal_name: dealName.trim(),
        description: "",
        buyer_id: buyerId || null,
        buyer_name: buyerName,
        location: selectedBuyer?.location || "",
        relationship_type: selectedBuyer?.relationship_type || "direct",
        commodity, quantity, instrument,
        pricing: "", state: "potential", heat: "0",
        direct_contact: "", intermediary: "",
        archived: false, created_at: nowISO(), updated_at: nowISO()
      };
      await sb.insert("deals", deal);
      dispatch({ type:"ADD_DEAL", deal });
      if (onCreated) onCreated(deal.id); // focus the new card (v9.3.101)
      onClose();
    } catch (e) {
      console.error(e);
      alert("Could not create deal: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = (errKey) => ({
    width:"100%", border:`1px solid ${errors[errKey] ? C.red : C.borderMid}`,
    borderRadius:8, padding:"8px 10px", fontSize:12, fontFamily:"inherit",
    outline:"none", color:C.text, background:"white"
  });

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background:C.bg, borderRadius:14, width:500, maxHeight:"85vh", overflow:"hidden", display:"flex", flexDirection:"column", boxShadow:"0 24px 64px rgba(0,0,0,0.25)" }}>

        {/* Header */}
        <div style={{ padding:"18px 22px 14px", borderBottom:`0.5px solid ${C.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ fontSize:15, fontWeight:600, color:C.text }}>New opportunity</div>
          <span onClick={onClose} style={{ cursor:"pointer", fontSize:20, color:C.textMuted, lineHeight:1 }}>×</span>
        </div>

        <div style={{ padding:"18px 22px", flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:16 }}>

          {/* 1. BUYER — first field */}
          <div>
            <SectionLabel>Buyer</SectionLabel>
            {!selectedBuyer && !createNewBuyer ? (
              <div>
                <input
                  placeholder="Search buyer registry…"
                  value={buyerSearch}
                  onChange={e => { setBuyerSearch(e.target.value); setErrors(v=>({...v,buyer:null})); }}
                  style={{ ...inputStyle("buyer"), borderColor: errors.buyer ? C.red : C.borderMid }}
                  autoFocus
                />
                {errors.buyer && <div style={{ fontSize:10, color:C.red, marginTop:3 }}>{errors.buyer}</div>}
                {buyerSearch && (
                  <div style={{ border:`0.5px solid ${C.border}`, borderRadius:8, marginTop:4, maxHeight:180, overflowY:"auto", boxShadow:"0 4px 12px rgba(0,0,0,0.08)" }}>
                    {filteredBuyers.length > 0 ? filteredBuyers.map(b => (
                      <div key={b.id} onClick={() => handleBuyerSelect(b)}
                        style={{ padding:"9px 12px", fontSize:12, cursor:"pointer", borderBottom:`0.5px solid ${C.border}`, color:C.text }}
                        onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <div style={{ fontWeight:500 }}>{b.company_name || b.name}</div>
                        {b.location && <div style={{ fontSize:10, color:C.textMuted }}>{b.location}</div>}
                      </div>
                    )) : (
                      <div>
                        <div style={{ padding:"9px 12px", fontSize:11, color:C.textMuted }}>No match — </div>
                        <div onClick={() => { setCreateNewBuyer(true); setNewBuyerName(buyerSearch); setNameManuallyEdited(false); }}
                          style={{ padding:"9px 12px", fontSize:11, color:C.tealText, cursor:"pointer", borderTop:`0.5px solid ${C.border}`, fontWeight:500 }}>
                          + Create new buyer: "{buyerSearch}"
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : selectedBuyer ? (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"9px 12px", background:C.tealLight, borderRadius:8, border:`0.5px solid ${C.tealBorder}` }}>
                <div>
                  <div style={{ fontSize:12, fontWeight:600, color:C.tealText }}>{selectedBuyer.company_name || selectedBuyer.name}</div>
                  {selectedBuyer.location && <div style={{ fontSize:10, color:C.tealText, opacity:0.8 }}>{selectedBuyer.location}</div>}
                </div>
                <span onClick={() => { setSelectedBuyer(null); setNameManuallyEdited(false); }} style={{ fontSize:18, cursor:"pointer", color:C.tealText }}>×</span>
              </div>
            ) : (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"9px 12px", background:C.purpleLight, borderRadius:8, border:`0.5px solid ${C.purpleBorder}` }}>
                <div style={{ fontSize:12, fontWeight:600, color:C.purple }}>New buyer: "{newBuyerName}"</div>
                <span onClick={() => { setCreateNewBuyer(false); setNewBuyerName(""); setNameManuallyEdited(false); }} style={{ fontSize:18, cursor:"pointer", color:C.purple }}>×</span>
              </div>
            )}
          </div>

          {/* 2. INSTRUMENT — second field, right after buyer */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div>
              <SectionLabel>Instrument</SectionLabel>
              <select value={instrument} onChange={e => handleInstrumentChange(e.target.value)}
                style={{ width:"100%", border:`1px solid ${errors.instrument ? C.red : C.borderMid}`, borderRadius:8, padding:"8px 10px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, background:"white" }}>
                {INSTRUMENTS.map(i => <option key={i}>{i}</option>)}
              </select>
              {errors.instrument && <div style={{ fontSize:10, color:C.red, marginTop:3 }}>{errors.instrument}</div>}
            </div>
            <div>
              <SectionLabel>Commodity</SectionLabel>
              <select value={commodity} onChange={e => { setCommodity(e.target.value); setErrors(v=>({...v,commodity:null})); }}
                style={{ width:"100%", border:`1px solid ${errors.commodity ? C.red : C.borderMid}`, borderRadius:8, padding:"8px 10px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, background:"white" }}>
                {COMMODITIES.map(c => <option key={c}>{c}</option>)}
              </select>
              {errors.commodity && <div style={{ fontSize:10, color:C.red, marginTop:3 }}>{errors.commodity}</div>}
            </div>
          </div>

          {/* 3. DEAL NAME — auto-generated, user can override */}
          <div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
              <SectionLabel>Deal name</SectionLabel>
              {nameManuallyEdited && buyerLabel && (
                <span onClick={() => { setDealName(`${buyerLabel} — ${instrument}`); setNameManuallyEdited(false); }}
                  style={{ fontSize:10, color:C.tealText, cursor:"pointer", textDecoration:"underline" }}>
                  ↺ Reset to auto-generated
                </span>
              )}
            </div>
            <input
              value={dealName}
              onChange={e => handleNameChange(e.target.value)}
              placeholder="Auto-generated from buyer + instrument"
              style={{ ...inputStyle("dealName") }}
            />
            {errors.dealName && <div style={{ fontSize:10, color:C.red, marginTop:3 }}>{errors.dealName}</div>}
            {!nameManuallyEdited && buyerLabel && (
              <div style={{ fontSize:10, color:C.textDim, marginTop:3 }}>Auto-generated — this is temporary and can be changed at any time</div>
            )}
          </div>

          {/* 4. QUANTITY — optional */}
          <div>
            <SectionLabel>Quantity <span style={{ color:C.textDim, fontWeight:400, textTransform:"none", letterSpacing:0 }}>(optional)</span></SectionLabel>
            <input value={quantity} onChange={e => setQuantity(e.target.value)}
              placeholder="e.g. 50kg, 100MT, 100 troy oz"
              style={{ ...inputStyle(null) }} />
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding:"14px 22px", borderTop:`0.5px solid ${C.border}`, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ fontSize:10, color:C.textDim }}>Seller matched after deal is created</div>
          <div style={{ display:"flex", gap:8 }}>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn variant="solid" onClick={handleSave}>{saving ? "Creating…" : "Create opportunity"}</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── DEAL PANEL ──
function DealPanel({ dealId, state, dispatch, onClose, width, onDragWidth, readOnly, onRestore, initialTab, onNavigateToTasks, searchNoteId, searchNoteQuery, onQualified }) {
  const [tab, setTab] = useState(initialTab || "info");

  // Switch to initialTab when it changes (e.g. navigating from calendar)
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab, dealId]);
  const deal = state.deals[dealId];
  if (!deal) {
    // Previously: return null (silent blank panel). That made a missing
    // record indistinguishable from "not loaded yet" — exactly what
    // happened when the Lead pill in Tasks navigated here before initial
    // load had finished. Now we say which one it is.
    return (
      <div style={{ display:"flex", flexShrink:0, height:"100%" }}>
        <DragHandle onMouseDown={onDragWidth} />
        <div style={{ width: width || 360, display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center", height:"100%", background:C.bg,
          flexShrink:0, borderLeft:`0.5px solid ${C.border}`, padding:24, textAlign:"center" }}>
          <div style={{ fontSize:12, color:C.textMuted, marginBottom:10 }}>
            {state.loaded
              ? "This record couldn't be found. It may have been deleted."
              : "Still loading…"}
          </div>
          <span onClick={onClose} style={{
            fontSize:11, fontWeight:500, color:C.tealText, cursor:"pointer",
            background:C.tealLight, border:`0.5px solid ${C.tealBorder}`,
            borderRadius:999, padding:"4px 14px"
          }}>Close</span>
        </div>
      </div>
    );
  }

  // Lead cards get their own stripped-down panel
  if (deal.state === "lead") {
    return <LeadPanel deal={deal} state={state} dispatch={dispatch} onClose={onClose} onNavigateToTasks={onNavigateToTasks} onQualified={onQualified} />;
  }

  const tabs = ["Info","Activity","Tasks"];

  return (
    <div style={{ display:"flex", flexShrink:0, height:"100%" }}>
      <DragHandle onMouseDown={onDragWidth} />
      <div style={{ width: width || 360, borderLeft:"none", display:"flex", flexDirection:"column", height:"100%", background:C.bg, flexShrink:0, borderLeft:`0.5px solid ${C.border}` }}>
      {/* Read-only banner */}
      {readOnly && (
        <div style={{ background:"#fef9ee", borderBottom:`0.5px solid #fcd34d`, padding:"6px 14px",
          display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <span style={{ fontSize:12 }}>🔒</span>
            <span style={{ fontSize:11, color:"#92400e" }}>Read-only — restore to make changes</span>
          </div>
          {onRestore && (
            <span onClick={onRestore} style={{
              fontSize:10, fontWeight:500, color:C.tealText, cursor:"pointer",
              background:C.tealLight, border:`0.5px solid ${C.tealBorder}`,
              borderRadius:999, padding:"3px 12px"
            }}>↺ Restore deal</span>
          )}
        </div>
      )}
      {/* Panel header */}
      <div style={{ padding:"12px 14px 0", borderBottom:`1px solid ${C.border}`, background:C.panelHeader, flexShrink:0 }}>
        {/* Completeness indicator */}
        {(() => {
          const missing = [];
          if (!deal.buyer_id) missing.push("buyer");
          if (!deal.instrument) missing.push("instrument");
          if (!deal.commodity) missing.push("commodity");
          const dealSellers = Object.values(state.dealSellers).filter(ds => ds.deal_id === deal.id);
          if (dealSellers.length === 0) missing.push("matched seller");
          if (missing.length === 0) return null;
          return (
            <div style={{ background:"#fffbeb", borderBottom:`0.5px solid #fcd34d`, padding:"5px 14px",
              display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
              <span style={{ fontSize:11 }}>⚠</span>
              <span style={{ fontSize:10, color:"#92400e" }}>
                Incomplete — missing: {missing.join(", ")}
              </span>
            </div>
          );
        })()}

        {/* Row 1: Deal name + heat + close */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, flex:1, paddingRight:8 }}>
            <div style={{ fontSize:16, fontWeight:700, color:C.text, lineHeight:1.3 }}>
              {deal.deal_name || deal.buyer_name || "Unnamed deal"}
            </div>
            {deal.heat && deal.heat !== "0" && (
              <span style={{ fontSize:14, lineHeight:1, flexShrink:0 }}>{HEAT_FLAMES[deal.heat]}</span>
            )}
          </div>
          <span onClick={onClose} style={{ cursor:"pointer", fontSize:20, color:C.textMuted, flexShrink:0, lineHeight:1 }}>×</span>
        </div>
        {/* Row 2: State / instrument / commodity / quantity — plain coloured text (v9.3.100) */}
        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:8, fontSize:10 }}>
          {(() => {
            const s = STATE_COLOURS[deal.state] || STATE_COLOURS.potential;
            const stateLabels = { potential:"Potential", active:"Active", dormant:"Dormant", closed_won:"Closed / Won", closed_lost:"Closed / Lost" };
            const parts = [];
            parts.push(<span key="st" style={{ color:s.text, fontWeight:600 }}>{stateLabels[deal.state]||deal.state}</span>);
            if (deal.instrument) parts.push(<span key="in" style={{ color:"#3b5bdb", fontWeight:500 }}>{deal.instrument}</span>);
            if (deal.commodity) parts.push(<span key="co" style={{ color:"#92400e", fontWeight:500 }}>{deal.commodity}</span>);
            if (deal.quantity) parts.push(<span key="qt" style={{ color:C.textMuted }}>{deal.quantity}</span>);
            return parts.flatMap((p, i) => i === 0 ? [p] : [<span key={`d${i}`} style={{ color:C.borderMid }}>·</span>, p]);
          })()}
        </div>
        {/* Row 3: Meta text — natural visual separator */}
        <div style={{ fontSize:10, color:C.textMuted, marginBottom:10, paddingTop:2, borderTop:`0.5px solid ${C.border}`, paddingTop:6 }}>
          {[deal.location, deal.relationship_type, deal.created_at ? `Created ${fmtRelDate(deal.created_at)}` : ""].filter(Boolean).join(" · ")}
        </div>
        {/* Row 4: Tabs — underline indicator, no bubbles (v9.3.100) */}
        <div style={{ display:"flex", borderBottom:`0.5px solid ${C.border}` }}>
          {tabs.map(t => {
            const active = tab === t.toLowerCase();
            return (
              <span key={t} onClick={() => setTab(t.toLowerCase())}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = C.text; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.color = C.textMuted; }}
                style={{
                  flex:1, textAlign:"center", padding:"7px 4px", fontSize:11,
                  fontWeight: active ? 600 : 500,
                  cursor:"pointer", userSelect:"none",
                  color: active ? C.tealText : C.textMuted,
                  borderBottom: `2px solid ${active ? C.teal : "transparent"}`,
                  marginBottom:-1,
                  transition:"color 0.12s, border-color 0.12s",
                }}>{t}</span>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex:1, overflowY:"auto" }}>
        {tab === "info"     && <DealInfoTab     deal={deal} state={state} dispatch={dispatch} readOnly={readOnly} />}
        {tab === "activity" && <DealActivityTab deal={deal} state={state} dispatch={dispatch} readOnly={readOnly} searchNoteId={tab === "activity" ? searchNoteId : null} searchNoteQuery={searchNoteQuery} />}
        {tab === "tasks"    && <DealTasksTab    deal={deal} state={state} dispatch={dispatch} readOnly={readOnly} />}
      </div>
    </div>
    </div>
  );
}

// ── DEAL INFO TAB ──
function PeopleTypeahead({ value, onChange, people, onAddPerson }) {
  const [query, setQuery] = useState(value || "");
  const [open, setOpen] = useState(false);

  const matches = people.filter(p => {
    const name = `${p.first_name||""} ${p.last_name||""}`.trim() || p.company || "";
    if (!query.trim()) return true;
    return name.toLowerCase().includes(query.toLowerCase());
  }).slice(0, 8);

  const handleChange = (e) => {
    setQuery(e.target.value);
    onChange(e.target.value);
    setOpen(true);
  };

  const handleSelect = (name) => {
    setQuery(name);
    onChange(name);
    setOpen(false);
  };

  const hasExactMatch = matches.some(p => {
    const name = `${p.first_name||""} ${p.last_name||""}`.trim() || p.company || "";
    return name.toLowerCase() === query.trim().toLowerCase();
  });

  return (
    <div style={{ position:"relative" }}>
      <input
        value={query}
        onChange={handleChange}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
        placeholder="Search people… or type a name"
        style={{ width:"100%", border:`1px solid ${C.teal}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }}
      />
      {open && (
        <div style={{ position:"absolute", top:"calc(100% + 2px)", left:0, right:0, background:"white",
          border:`1px solid ${C.border}`, borderRadius:6, zIndex:20,
          boxShadow:"0 4px 12px rgba(0,0,0,0.1)", maxHeight:200, overflowY:"auto" }}>
          {matches.length === 0 && !query.trim() && (
            <div style={{ padding:"8px 10px", fontSize:11, color:C.textDim, fontStyle:"italic" }}>
              No people in registry yet
            </div>
          )}
          {matches.map(p => {
            const name = `${p.first_name||""} ${p.last_name||""}`.trim() || p.company || p.id;
            return (
              <div key={p.id} onMouseDown={() => handleSelect(name)}
                style={{ padding:"8px 10px", fontSize:12, cursor:"pointer",
                  borderBottom:`0.5px solid ${C.border}`, color:C.text }}
                onMouseEnter={e => e.currentTarget.style.background = C.tealLight}
                onMouseLeave={e => e.currentTarget.style.background = "white"}>
                <div style={{ fontWeight:500 }}>{name}</div>
                {p.role && <div style={{ fontSize:10, color:C.textMuted }}>{p.role}</div>}
              </div>
            );
          })}
          {query.trim() && !hasExactMatch && onAddPerson && (
            <div onMouseDown={() => { onAddPerson(query.trim()); handleSelect(query.trim()); }}
              style={{ padding:"8px 10px", fontSize:11, cursor:"pointer", color:C.teal,
                fontWeight:600, borderTop:`0.5px solid ${C.border}`,
                display:"flex", alignItems:"center", gap:6 }}
              onMouseEnter={e => e.currentTarget.style.background = C.tealLight}
              onMouseLeave={e => e.currentTarget.style.background = "white"}>
              <span style={{ fontSize:14 }}>+</span> Add "{query.trim()}" to People registry
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function DealInfoTab({ deal, state, dispatch, readOnly }) {
  const { confirmEl, confirm } = useConfirm();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    deal_name: deal.deal_name || "",
    description: deal.description || "",
    quantity: deal.quantity || "",
    pricing: deal.pricing || "",
    instrument: deal.instrument || "CIF",
    commodity: deal.commodity || "Gold Doré",
    state: deal.state || "potential",
    heat: deal.heat || "0",
    direct_contact: deal.direct_contact || "",
    intermediary: deal.intermediary || "",
  });
  const [showInstrumentNudge, setShowInstrumentNudge] = useState(false);
  const [showClosePrompt, setShowClosePrompt] = useState(false);
  const [closeOutcome, setCloseOutcome] = useState(null);
  const [closeReason, setCloseReason] = useState("");
  const [closeActioning, setCloseActioning] = useState(false);
  const [closeError, setCloseError] = useState("");

  const save = async () => {
    try {
      const updates = {
        deal_name:      form.deal_name,
        description:    form.description,
        instrument:     form.instrument,
        commodity:      form.commodity,
        quantity:       form.quantity,
        pricing:        form.pricing,
        location:       form.location,
        state:          form.state,
        heat:           form.heat,
        direct_contact: form.direct_contact,
        intermediary:   form.intermediary,
        relationship_type: form.relationship_type,
        notes:          form.notes,
        updated_at:     nowISO(),
      };
      await sb.update("deals", deal.id, updates);
      dispatch({ type:"UPDATE_DEAL", id:deal.id, updates });
      setEditing(false);
    } catch (e) {
      console.error("Deal save failed:", e);
      alert(`Save failed: ${e.message}`);
    }
  };

  const dealSellers = Object.values(state.dealSellers).filter(ds => ds.deal_id === deal.id);
  const primary = dealSellers.find(ds => ds.role === "primary");
  const candidates = dealSellers.filter(ds => ds.role !== "primary");

  const getSellerName = (sellerId) => {
    const s = state.sellers[sellerId];
    return s ? (s.company_name || s.name) : "Unknown seller";
  };

  const setRole = async (dsId, role) => {
    try {
      await sb.update("deal_sellers", dsId, { role });
      dispatch({ type:"UPDATE_DEAL_SELLER", id:dsId, updates:{ role } });
    } catch (e) { console.error(e); }
  };

  const removeSeller = async (dsId) => {
    try {
      await sb.delete("deal_sellers", dsId);
      dispatch({ type:"DELETE_DEAL_SELLER", id:dsId });
    } catch (e) { console.error(e); }
  };

  const archive = async () => {
    if (!await confirm(`Archive "${deal.deal_name || "this deal"}"?`)) return;
    try {
      await sb.update("deals", deal.id, { archived:true });
      dispatch({ type:"UPDATE_DEAL", id:deal.id, updates:{ archived:true } });
    } catch (e) { console.error(e); }
  };

  const deleteDeal = async () => {
    if (!await confirm(`Delete "${deal.deal_name || "this deal"}"? This cannot be undone.`)) return;
    try {
      await sb.delete("deals", deal.id);
      dispatch({ type:"DELETE_DEAL", id:deal.id });
    } catch (e) { console.error(e); }
  };

  const addPersonToPeople = async (name) => {
    const parts = name.trim().split(" ");
    const first = parts[0] || "";
    const last = parts.slice(1).join(" ") || "";
    try {
      const person = {
        id: genId(), first_name: first, last_name: last,
        company:"", role:"", status:"active",
        passport_number:"", notes:"", contacts:[],
        linked_buyers:[], linked_sellers:[], created_at: nowISO()
      };
      await sb.insert("people", person);
      dispatch({ type:"ADD_PERSON", person });
    } catch(e) { console.error("Add person failed:", e); }
  };

    const people = Object.values(state.people);

  const f = (key) => editing ? (
    key === "description" ? (
      <textarea dir="ltr" value={form[key]} onChange={e => setForm({...form,[key]:e.target.value})}
        style={{ width:"100%", border:`1px solid ${C.teal}`, borderRadius:6, padding:"6px 8px", fontSize:12, fontFamily:"inherit", resize:"none", minHeight:72, outline:"none", color:C.text }} />
    ) : key === "state" ? (
      <select value={form[key]} onChange={e => setForm({...form,[key]:e.target.value})} style={{ border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, appearance:"none" }}>
        {DEAL_STATES.filter(s => s !== "closed_won" && s !== "closed_lost").map(s => <option key={s} value={s}>{s}</option>)}
      </select>
    ) : key === "instrument" ? (
      <select value={form[key]} onChange={e => {
        const newInstr = e.target.value;
        const oldInstr = form.instrument;
        setForm({...form, instrument: newInstr});
        // Show nudge if deal name contains the old instrument and the instrument actually changed
        if (oldInstr !== newInstr && form.deal_name && form.deal_name.includes(oldInstr)) {
          setShowInstrumentNudge({ oldInstr, newInstr });
        } else {
          setShowInstrumentNudge(false);
        }
      }} style={{ border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, appearance:"none" }}>
        {INSTRUMENTS.map(i => <option key={i}>{i}</option>)}
      </select>
    ) : key === "commodity" ? (
      <select value={form[key]} onChange={e => setForm({...form,[key]:e.target.value})} style={{ border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, appearance:"none" }}>
        {COMMODITIES.map(c => <option key={c}>{c}</option>)}
      </select>
    ) : key === "heat" ? (
      <select value={form[key]} onChange={e => setForm({...form,[key]:e.target.value})} style={{ border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, appearance:"none" }}>
        {["0","1","2","3"].map(h => <option key={h} value={h}>{HEAT_FLAMES[h] || "None"}</option>)}
      </select>
    ) : (key === "direct_contact" || key === "intermediary") ? (
      <PeopleTypeahead
        value={form[key] || ""}
        onChange={val => setForm({...form, [key]: val})}
        people={people}
        onAddPerson={addPersonToPeople}
      />
    ) : (
      <input value={form[key]} onChange={e => setForm({...form,[key]:e.target.value})}
        style={{ width:"100%", border:`1px solid ${C.teal}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
    )
  ) : (
    <span style={{ fontSize:12, color: form[key] ? C.text : C.textDim }}>{form[key] || "—"}</span>
  );

  return (
    <div style={{ padding:"14px", display:"flex", flexDirection:"column", gap:12 }}>
      {/* Edit toggle */}
      <div style={{ display:"flex", justifyContent:"flex-end" }}>
        {editing ? (
          <div style={{ display:"flex", flexDirection:"column", gap:8, width:"100%" }}>
            {/* Instrument nudge — shown when name contains old instrument */}
            {showInstrumentNudge && (
              <div style={{ background:"#fffbeb", border:`1px solid #fcd34d`, borderRadius:7,
                padding:"8px 12px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
                <span style={{ fontSize:11, color:"#92400e" }}>
                  Deal name still says "{showInstrumentNudge.oldInstr}" — update it to match?
                </span>
                <div style={{ display:"flex", gap:5, flexShrink:0 }}>
                  <Btn onClick={() => {
                    setForm(f => ({ ...f, deal_name: f.deal_name.replace(showInstrumentNudge.oldInstr, showInstrumentNudge.newInstr) }));
                    setShowInstrumentNudge(false);
                  }} style={{ fontSize:10, padding:"2px 10px", background:"#fef3c7", borderColor:"#fcd34d", color:"#92400e" }}>
                    Yes, update
                  </Btn>
                  <Btn onClick={() => setShowInstrumentNudge(false)} style={{ fontSize:10, padding:"2px 10px" }}>
                    Keep as is
                  </Btn>
                </div>
              </div>
            )}
            <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
              <Btn onClick={() => { setEditing(false); setShowInstrumentNudge(false); }}>Cancel</Btn>
              <Btn variant="teal" onClick={save}>Save</Btn>
            </div>
          </div>
        ) : (
          !readOnly && <Btn onClick={() => setEditing(true)}>Edit</Btn>
        )}
      </div>

      {/* Fields */}
      {[
        { label:"Deal name", key:"deal_name" },
        { label:"Description", key:"description" },
        { label:"Commodity", key:"commodity" },
        { label:"Quantity", key:"quantity" },
        { label:"Pricing", key:"pricing" },
        { label:"Instrument", key:"instrument" },
        { label:"State", key:"state" },
        { label:"Heat", key:"heat" },
        { label:"Direct contact", key:"direct_contact" },
        { label:"Intermediary", key:"intermediary" },
      ].map(({ label, key }) => (
        <div key={key}>
          <SectionLabel>{label}</SectionLabel>
          {f(key)}
        </div>
      ))}

      <Divider />

      {/* Sellers section */}
      <div>
        <SectionLabel>Matched sellers</SectionLabel>
        {primary && (
          <div style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", background:C.greenLight, borderRadius:8, border:`0.5px solid ${C.greenBorder}`, marginBottom:6 }}>
            <span style={{ fontSize:11, fontWeight:500, color:C.green, flex:1 }}>{getSellerName(primary.seller_id)}</span>
            <span style={{ fontSize:9, color:C.green, background:"white", borderRadius:999, padding:"1px 6px", border:`0.5px solid ${C.greenBorder}` }}>Primary</span>
            <span onClick={() => removeSeller(primary.id)} style={{ fontSize:14, color:C.green, cursor:"pointer" }}>×</span>
          </div>
        )}
        {candidates.map(ds => (
          <div key={ds.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", background:C.bgSecondary, borderRadius:8, border:`0.5px solid ${C.border}`, marginBottom:6 }}>
            <span style={{ fontSize:11, color:C.text, flex:1 }}>{getSellerName(ds.seller_id)}</span>
            <span onClick={() => setRole(ds.id, "primary")} style={{ fontSize:9, color:C.tealText, cursor:"pointer", borderRadius:999, padding:"1px 7px", border:`0.5px solid ${C.tealBorder}`, background:C.tealLight }}>Set primary</span>
            <span onClick={() => removeSeller(ds.id)} style={{ fontSize:14, color:C.textMuted, cursor:"pointer" }}>×</span>
          </div>
        ))}
        {dealSellers.length === 0 && (
          <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No sellers matched yet</div>
        )}
        {!readOnly && <AddSellerToDeal dealId={deal.id} state={state} dispatch={dispatch} />}
      </div>

      <Divider />

      {/* Actions */}
      {!readOnly && (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          <div style={{ display:"flex", gap:6 }}>
            <Btn onClick={() => setShowClosePrompt(true)} style={{ flex:1, justifyContent:"center" }}>
              <span style={{ fontSize:12 }}>✔</span> Close deal
            </Btn>
            <Btn onClick={archive} style={{ flex:1, justifyContent:"center" }}>
              <span style={{ fontSize:12 }}>🗄</span> Archive
            </Btn>
            <Btn variant="red" onClick={deleteDeal} style={{ flex:1, justifyContent:"center" }}>
              <span style={{ fontSize:12 }}>🗑</span> Delete
            </Btn>
          </div>

          {showClosePrompt && (
            <div style={{ background:C.greenLight, border:`0.5px solid ${C.greenBorder}`, borderRadius:8, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8, marginTop:2 }}>
              <div style={{ fontSize:11, fontWeight:500, color:C.green }}>How did this deal close?</div>
              <div style={{ display:"flex", gap:6 }}>
                {["won","lost"].map(o => (
                  <span key={o} onClick={() => { setCloseOutcome(o); setCloseError(""); }}
                    style={{ flex:1, textAlign:"center", fontSize:11, fontWeight:500, borderRadius:6, padding:"6px 0", cursor:"pointer", textTransform:"capitalize",
                      border:`0.5px solid ${closeOutcome===o ? (o==="won"?C.green:C.red) : C.border}`,
                      background: closeOutcome===o ? (o==="won"?C.green:C.red) : "transparent",
                      color: closeOutcome===o ? "#fff" : C.textMuted }}>{o}</span>
                ))}
              </div>
              <textarea dir="ltr" value={closeReason} onChange={e => { setCloseReason(e.target.value); setCloseError(""); }}
                placeholder="Why did it close this way?" rows={2}
                style={{ width:"100%", border:`0.5px solid ${C.greenBorder}`, borderRadius:5, padding:"6px 8px", fontSize:11, fontFamily:"inherit", resize:"none", outline:"none", color:C.text, lineHeight:1.5 }} />
              {closeError && <div style={{ fontSize:10.5, color:C.red }}>{closeError}</div>}
              <div style={{ display:"flex", gap:5, justifyContent:"flex-end" }}>
                <Btn onClick={() => { setShowClosePrompt(false); setCloseOutcome(null); setCloseReason(""); setCloseError(""); }}>Cancel</Btn>
                <Btn style={{ background:C.green, color:"#fff", borderColor:C.green, opacity:closeActioning?0.5:1 }} onClick={async () => {
                  if (!closeOutcome) { setCloseError("Choose Won or Lost."); return; }
                  if (!closeReason.trim()) { setCloseError("A reason is required to close a deal."); return; }
                  setCloseActioning(true);
                  try {
                    const updates = {
                      state: closeOutcome === "won" ? "closed_won" : "closed_lost",
                      close_reason: closeReason.trim(),
                      archived: true,
                      updated_at: nowISO(),
                    };
                    await sb.update("deals", deal.id, updates);
                    dispatch({ type:"UPDATE_DEAL", id:deal.id, updates });
                    setShowClosePrompt(false); setCloseOutcome(null); setCloseReason(""); setCloseError("");
                  } catch(e){ console.error(e); setCloseError("Something went wrong — try again."); } finally { setCloseActioning(false); }
                }}>
                  {closeActioning ? "Closing…" : "Close deal"}
                </Btn>
              </div>
            </div>
          )}
        </div>
      )}
      {confirmEl}
    </div>
  );
}

function AddSellerToDeal({ dealId, state, dispatch }) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const existing = new Set(Object.values(state.dealSellers).filter(ds => ds.deal_id === dealId).map(ds => ds.seller_id));
  const sellers = Object.values(state.sellers).filter(s => !existing.has(s.id) && (s.company_name || s.name || "").toLowerCase().includes(search.toLowerCase()));

  const add = async (seller) => {
    const ds = { id: genId(), deal_id: dealId, seller_id: seller.id, role: "candidate", created_at: nowISO() };
    try {
      await sb.insert("deal_sellers", ds);
      dispatch({ type:"ADD_DEAL_SELLER", ds });
      setSearch(""); setOpen(false);
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ marginTop:6 }}>
      {!open ? (
        <span onClick={() => setOpen(true)} style={{ fontSize:11, color:C.tealText, cursor:"pointer", display:"flex", alignItems:"center", gap:4 }}>
          + Match a seller
        </span>
      ) : (
        <div>
          <input autoFocus placeholder="Search sellers…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width:"100%", border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"6px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
          <div style={{ border:`0.5px solid ${C.border}`, borderRadius:6, marginTop:3, maxHeight:120, overflowY:"auto" }}>
            {sellers.slice(0,8).map(s => (
              <div key={s.id} onClick={() => add(s)} style={{ padding:"6px 10px", fontSize:11, cursor:"pointer", borderBottom:`0.5px solid ${C.border}`, color:C.text }}
                onMouseEnter={e => e.currentTarget.style.background = C.tealLight}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                {s.company_name || s.name}
              </div>
            ))}
            {sellers.length === 0 && <div style={{ padding:"6px 10px", fontSize:11, color:C.textDim }}>No sellers found</div>}
          </div>
          <span onClick={() => setOpen(false)} style={{ fontSize:10, color:C.textMuted, cursor:"pointer" }}>Cancel</span>
        </div>
      )}
    </div>
  );
}

// ── DEAL ACTIVITY TAB ──
function DealActivityTab({ deal, state, dispatch, readOnly, searchNoteId, searchNoteQuery }) {
  const [activeChannel, setActiveChannel] = useState(null);
  const [text, setText] = useState("");
  const [callResult, setCallResult] = useState("");
  const [meetingPlace, setMeetingPlace] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [driveLink, setDriveLink] = useState("");
  const [driveLinkLabel, setDriveLinkLabel] = useState("");
  const [showMeta, setShowMeta] = useState(false);
  const [sortAsc, setSortAsc] = useState(false); // false = newest first (default)
  const [docsOnly, setDocsOnly] = useState(false); // 🔗 Documents filter (v9.3.96)
  const [saving, setSaving] = useState(false);
  const noteRefs = useRef({});

  // If the note we're jumping to is a metadata/system event, switch on
  // "show metadata" so it isn't filtered out of the list before we can
  // scroll to it.
  useEffect(() => {
    if (!searchNoteId) return;
    const target = state.threads[searchNoteId];
    if (target?.is_system_event) setShowMeta(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchNoteId]);

  const entries = Object.values(state.threads)
    .filter(e => e.card_id === deal.id && (showMeta || !e.is_system_event) && (!docsOnly || e.drive_link))
    .sort((a,b) => sortAsc
      ? new Date(a.created_at) - new Date(b.created_at)
      : new Date(b.created_at) - new Date(a.created_at)
    );

  // Scroll the matched note into view and let ActivityEntry highlight it.
  useEffect(() => {
    if (!searchNoteId) return;
    const target = entries.find(e => e.id === searchNoteId);
    if (!target) return;
    const el = noteRefs.current[searchNoteId];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    // One-shot: this only needs to fire once when the panel mounts on a search nav.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchNoteId, entries.length]);

  const openForm = (ch) => {
    setActiveChannel(ch === activeChannel ? null : ch);
    setText(""); setCallResult(""); setMeetingPlace(""); setEmailSubject(""); setDriveLink(""); setDriveLinkLabel("");
  };

  const saveEntry = async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      const entry = {
        id: genId(), card_id: deal.id, card_type: "deal",
        channel: activeChannel, text: text.trim(),
        call_result: callResult, meeting_place: meetingPlace,
        email_subject: emailSubject,
        is_system_event: false, created_at: nowISO()
      };
      // Attempt to include drive_link fields — silently omit if column doesn't exist
      if (driveLink.trim()) {
        try {
          const testEntry = { ...entry, drive_link: driveLink.trim(), drive_link_label: driveLinkLabel.trim() || null };
          await sb.insert("thread_entries", testEntry);
          dispatch({ type:"ADD_THREAD", entry: testEntry });
        } catch(e2) {
          // drive_link column missing — save without it
          await sb.insert("thread_entries", entry);
          dispatch({ type:"ADD_THREAD", entry });
        }
      } else {
        await sb.insert("thread_entries", entry);
        dispatch({ type:"ADD_THREAD", entry });
      }
      // Promote deal to top of lane by stamping updated_at
      try {
        await sb.update("deals", deal.id, { updated_at: nowISO() });
        dispatch({ type:"UPDATE_DEAL", id:deal.id, updates:{ updated_at: nowISO() } });
      } catch(e2) { /* non-critical, ignore */ }
      setActiveChannel(null); setText(""); setDriveLink(""); setDriveLinkLabel(""); setSaving(false);
    } catch (e) { console.error(e); setSaving(false); }
  };

  const deleteEntry = async (id) => {
    try {
      await sb.delete("thread_entries", id);
      dispatch({ type:"DELETE_THREAD", id });
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      {/* Channel triggers — icon circles, colour reveals on hover (v9.3.98) */}
      {!readOnly && (
        <div style={{ display:"flex", gap:8, padding:"9px 14px", borderBottom:`0.5px solid ${C.border}`, flexShrink:0, alignItems:"center" }}>
          {CHANNELS.map(ch => {
            const col = CH_COLOUR[ch];
            const isActive = activeChannel === ch;
            return (
              <span key={ch} onClick={() => openForm(ch)} title={`Log ${ch.toLowerCase()}`}
                onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = col.bg; e.currentTarget.style.borderColor = col.border; const i = e.currentTarget.firstChild; i.style.color = col.text; i.style.opacity = 1; } }}
                onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = C.borderMid; const i = e.currentTarget.firstChild; i.style.color = C.textMuted; i.style.opacity = 0.7; } }}
                style={{
                  width:26, height:26, borderRadius:"50%", flexShrink:0,
                  display:"inline-flex", alignItems:"center", justifyContent:"center",
                  border:`1px solid ${isActive ? col.text : C.borderMid}`,
                  background: isActive ? col.bg : "transparent",
                  cursor:"pointer", userSelect:"none",
                  transition:"background 0.12s, border-color 0.12s",
                  boxShadow: isActive ? `0 0 0 2px ${col.border}` : "none"
                }}>
                <i className={`ti ${CH_ICON[ch]}`} style={{ fontSize:13, color: isActive ? col.text : C.textMuted, opacity: isActive ? 1 : 0.7, transition:"color 0.12s, opacity 0.12s" }} />
              </span>
            );
          })}
        </div>
      )}

      {/* Compose form — hidden when readOnly */}
      {!readOnly && activeChannel && (
        <div style={{ padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, background:C.bgSecondary, flexShrink:0 }}>
          <div style={{ fontSize:11, fontWeight:600, color:C.tealText, marginBottom:8 }}>Log {activeChannel.toLowerCase()}</div>
          {activeChannel === "Call" && (
            <div style={{ display:"flex", gap:6, marginBottom:6 }}>
              <select value={callResult} onChange={e => setCallResult(e.target.value)} style={{ flex:1, border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text, appearance:"none" }}>
                <option value="">Result…</option>
                {["Interested","Not interested","Follow up","No answer","Left message"].map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
          )}
          {activeChannel === "Meeting" && (
            <input placeholder="Location…" value={meetingPlace} onChange={e => setMeetingPlace(e.target.value)}
              style={{ width:"100%", border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", marginBottom:6, color:C.text }} />
          )}
          {activeChannel === "Email" && (
            <input placeholder="Subject…" value={emailSubject} onChange={e => setEmailSubject(e.target.value)}
              style={{ width:"100%", border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", marginBottom:6, color:C.text }} />
          )}
          <textarea dir="ltr" placeholder="Add notes…" value={text} onChange={e => setText(e.target.value)} rows={3}
            style={{ width:"100%", border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"6px 8px", fontSize:11, fontFamily:"inherit", resize:"none", outline:"none", color:C.text }} />
          {/* Drive link — label + URL */}
          <div style={{ marginTop:6, background:"white", border:`1px solid ${C.borderMid}`, borderRadius:6, padding:"8px 10px" }}>
            <div style={{ fontSize:10, color:C.textMuted, marginBottom:5, fontWeight:500 }}>📎 Attach document (optional)</div>
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <input placeholder="Label e.g. FCO Draft v2" value={driveLinkLabel} onChange={e => setDriveLinkLabel(e.target.value)}
                style={{ width:"100%", border:`1px solid ${C.borderMid}`, borderRadius:5, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
              <input placeholder="https://docs.google.com/… (URL)" value={driveLink} onChange={e => setDriveLink(e.target.value)}
                style={{ width:"100%", border:`1px solid ${C.borderMid}`, borderRadius:5, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
            </div>
          </div>
          <div style={{ display:"flex", justifyContent:"flex-end", gap:6, marginTop:8 }}>
            <Btn onClick={() => setActiveChannel(null)}>Cancel</Btn>
            <Btn variant="solid" onClick={saveEntry}>{saving ? "Saving…" : "Save"}</Btn>
          </div>
        </div>
      )}

      {/* Filter bar — icons with tooltips, no boxed buttons (v9.3.98) */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 14px", borderBottom:`0.5px solid ${C.border}`, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span onClick={() => setSortAsc(v => !v)} title={sortAsc ? "Oldest first — click for newest first" : "Newest first — click for oldest first"}
            onMouseEnter={e => { e.currentTarget.style.color = C.text; }}
            onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; }}
            style={{ display:"inline-flex", alignItems:"center", cursor:"pointer", userSelect:"none", color:C.textMuted, transition:"color 0.12s" }}>
            <i className={`ti ${sortAsc ? "ti-sort-ascending" : "ti-sort-descending"}`} style={{ fontSize:15 }} />
          </span>
          <span onClick={() => setDocsOnly(v => !v)} title={docsOnly ? "Showing linked documents only — click to show all activity" : "Show linked documents only"}
            onMouseEnter={e => { if (!docsOnly) e.currentTarget.style.color = C.text; }}
            onMouseLeave={e => { if (!docsOnly) e.currentTarget.style.color = C.textMuted; }}
            style={{ display:"inline-flex", alignItems:"center", cursor:"pointer", userSelect:"none",
              color: docsOnly ? C.blue : C.textMuted, transition:"color 0.12s" }}>
            <i className="ti ti-paperclip" style={{ fontSize:15 }} />
          </span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer" }} onClick={() => setShowMeta(!showMeta)}>
          <span style={{ fontSize:10, color:C.textMuted }}>Show metadata</span>
          <div style={{ width:28, height:16, borderRadius:8, background: showMeta ? C.teal : C.borderMid, position:"relative", transition:"background 0.2s" }}>
            <div style={{ width:12, height:12, background:"white", borderRadius:"50%", position:"absolute", top:2, transform: showMeta ? "translateX(14px)" : "translateX(2px)", transition:"transform 0.2s" }} />
          </div>
        </div>
      </div>

      {/* Thread log */}
      <div style={{ flex:1, overflowY:"auto", padding:"12px 14px", display:"flex", flexDirection:"column", gap:12 }}>
        {entries.length === 0 ? (
          <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic", textAlign:"center", paddingTop:20 }}>
            {docsOnly ? "No linked documents on this deal yet." : "No activity yet. Use the triggers above to log the first entry."}
          </div>
        ) : entries.map((entry, idx) => (
          <ActivityEntry
            key={entry.id}
            entry={entry}
            onDelete={deleteEntry}
            dispatch={dispatch}
            readOnly={readOnly}
            isLast={idx === entries.length - 1}
            forwardedRef={el => { if (el) noteRefs.current[entry.id] = el; }}
            searchWords={entry.id === searchNoteId && searchNoteQuery ? [searchNoteQuery] : null}
            isSearchMatch={entry.id === searchNoteId}
          />
        ))}
      </div>
    </div>
  );
}

function ActivityEntry({ entry, onDelete, dispatch, readOnly, isLast, dealLabel, onDealClick, searchWords, forwardedRef, isSearchMatch }) {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(entry.text || "");
  const [editDriveLink, setEditDriveLink] = useState(entry.drive_link || "");
  const [editDriveLinkLabel, setEditDriveLinkLabel] = useState(entry.drive_link_label || "");
  const [saving, setSaving] = useState(false);
  // Fades the "you searched for this" background after a few seconds so the
  // highlighted text (from HighlightedText, via searchWords) remains but the
  // row doesn't stay tinted forever.
  const [showMatchBg, setShowMatchBg] = useState(!!isSearchMatch);
  useEffect(() => {
    if (!isSearchMatch) return;
    const t = setTimeout(() => setShowMatchBg(false), 2600);
    return () => clearTimeout(t);
  }, [isSearchMatch]);

  const taskEvent = isTaskEvent(entry);
  const TASK_EVENT_ICON = { task_created:"☐", task_completed:"☑", task_archived:"🗄", task_doc:"🔗" };
  const TASK_EVENT_LABEL = { task_created:"Task", task_completed:"Task", task_archived:"Task", task_doc:"Document" };
  const col = (entry.is_system_event || taskEvent) ? null : CH_COLOUR[entry.channel];

  const saveEdit = async () => {
    if (!editText.trim()) return;
    setSaving(true);
    try {
      const updates = {
        text: editText.trim(),
        drive_link: editDriveLink.trim() || null,
        drive_link_label: editDriveLinkLabel.trim() || null,
      };
      await sb.update("thread_entries", entry.id, updates);
      dispatch({ type:"UPDATE_THREAD", id:entry.id, updates });
      setEditing(false);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const cancelEdit = () => {
    setEditText(entry.text || "");
    setEditDriveLink(entry.drive_link || "");
    setEditDriveLinkLabel(entry.drive_link_label || "");
    setEditing(false);
  };

  return (
    <div ref={forwardedRef} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onClick={!editing && onDealClick ? onDealClick : undefined}
      style={{ display:"flex", gap:0, cursor: !editing && onDealClick ? "pointer" : "default",
        borderRadius:6, transition:"background 0.4s",
        padding: showMatchBg ? "4px 6px" : 0, margin: showMatchBg ? "-4px -6px" : 0,
        background: showMatchBg ? "#fef3c7" : (hovered && onDealClick && !editing ? C.bgSecondary : "transparent") }}>

      {/* Timeline column */}
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", width:36, flexShrink:0 }}>
        {/* Icon */}
        {taskEvent ? (
          <div style={{ width:30, height:30, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center",
            background:C.bgSecondary, color:C.textMuted, border:`1px solid ${C.borderMid}`, fontSize:13, flexShrink:0, zIndex:1 }}>
            {TASK_EVENT_ICON[entry.entry_type]}
          </div>
        ) : col ? (
          <div style={{ width:30, height:30, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center",
            background:col.bg, color:col.text, border:`1px solid ${col.border}`, fontSize:12, flexShrink:0, zIndex:1 }}>
            {entry.channel === "Note" ? "📝" : entry.channel === "Email" ? "✉" : entry.channel === "Call" ? "📞" : entry.channel === "WhatsApp" ? "💬" : "🤝"}
          </div>
        ) : (
          <div style={{ width:22, height:22, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center",
            background:C.bgSecondary, border:`1px solid ${C.border}`, fontSize:10, color:C.textDim, flexShrink:0, zIndex:1 }}>ℹ</div>
        )}
        {/* Connector line — shown for all except last entry */}
        {!isLast && (
          <div style={{ width:2, flex:1, minHeight:16, background:C.border, borderRadius:1, marginTop:2 }} />
        )}
      </div>

      {/* Content */}
      <div style={{ flex:1, minWidth:0, paddingBottom: isLast ? 0 : 16, paddingLeft:10 }}>
        {/* Header row */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ fontSize:11, fontWeight:600, color:C.text }}>{taskEvent ? TASK_EVENT_LABEL[entry.entry_type] : entry.channel}</span>
            {dealLabel && (
              <span onClick={e => { e.stopPropagation(); onDealClick && onDealClick(); }}
                style={{ display:"inline-flex", alignItems:"center", borderRadius:999,
                  padding:"1px 8px", fontSize:10, fontWeight:500,
                  background:C.tealLight, color:C.tealText, border:`1px solid ${C.tealBorder}`,
                  cursor: onDealClick ? "pointer" : "default" }}>
                🔗 {dealLabel}
              </span>
            )}
            {/* Inline metadata when in calendar context (dealLabel present) */}
            {dealLabel && entry.call_result && (
              <Pill style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:9 }}>{entry.call_result}</Pill>
            )}
            {dealLabel && entry.meeting_place && (
              <span style={{ fontSize:10, color:C.textMuted }}>📍 {entry.meeting_place}</span>
            )}
            {dealLabel && entry.email_subject && (
              <span style={{ fontSize:10, color:C.textMuted }}>"{entry.email_subject}"</span>
            )}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ fontSize:9, color:C.textDim }}>{fmtDate(entry.created_at)} · {fmtTime(entry.created_at)}</span>
            {hovered && !entry.is_system_event && !taskEvent && !editing && !readOnly && (
              <>
                <span onClick={e => { e.stopPropagation(); setEditText(entry.text || ""); setEditing(true); }}
                  style={{ fontSize:10, color:C.textMuted, cursor:"pointer", padding:"2px 7px", borderRadius:4, border:`1px solid ${C.border}`, background:"white" }}>✏ Edit</span>
                <span onClick={e => { e.stopPropagation(); onDelete(entry.id); }}
                  style={{ fontSize:10, color:C.red, cursor:"pointer", padding:"2px 7px", borderRadius:4, border:`1px solid ${C.redBorder}`, background:C.redLight }}>🗑</span>
              </>
            )}
          </div>
        </div>
        {/* Body */}
        {editing ? (
          <div>
            <textarea dir="ltr" autoFocus value={editText} onChange={e => setEditText(e.target.value)} rows={3}
              style={{ width:"100%", border:`1px solid ${C.tealBorder}`, borderRadius:6, padding:"6px 8px", fontSize:11, fontFamily:"inherit", resize:"none", outline:"none", color:C.text, lineHeight:1.5, background:"white" }} />
            {/* Drive link edit fields */}
            <div style={{ marginTop:6, background:C.bgSecondary, border:`1px solid ${C.border}`, borderRadius:6, padding:"7px 9px" }}>
              <div style={{ fontSize:10, color:C.textMuted, marginBottom:4, fontWeight:500 }}>🔗 Linked document</div>
              <input dir="ltr" placeholder="Label e.g. FCO Draft v2" value={editDriveLinkLabel} onChange={e => setEditDriveLinkLabel(e.target.value)}
                style={{ width:"100%", border:`1px solid ${C.borderMid}`, borderRadius:5, padding:"4px 7px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text, marginBottom:4 }} />
              <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                <input dir="ltr" placeholder="https://docs.google.com/…" value={editDriveLink} onChange={e => setEditDriveLink(e.target.value)}
                  style={{ flex:1, border:`1px solid ${C.borderMid}`, borderRadius:5, padding:"4px 7px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
                {editDriveLink.trim() && (
                  <a href={editDriveLink.trim()} target="_blank" rel="noreferrer"
                    style={{ fontSize:10, color:C.blue, textDecoration:"none", padding:"4px 8px", borderRadius:5, border:`1px solid ${C.blueBorder}`, background:C.blueLight, whiteSpace:"nowrap", flexShrink:0 }}>
                    Open ↗
                  </a>
                )}
              </div>
            </div>
            <div style={{ display:"flex", gap:5, marginTop:6, justifyContent:"flex-end" }}>
              <Btn onClick={cancelEdit}>Cancel</Btn>
              <Btn variant="teal" onClick={saveEdit}>{saving ? "Saving…" : "Save"}</Btn>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize:11, color:C.text, lineHeight:1.6, whiteSpace:"pre-wrap", wordBreak:"break-word" }}><HighlightedText text={entry.text} words={searchWords} /></div>
            {entry.drive_link && (
              <a href={entry.drive_link} target="_blank" rel="noreferrer"
                style={{ fontSize:10, color:C.blue, textDecoration:"none", cursor:"pointer", display:"inline-flex", alignItems:"center", gap:4, marginTop:5,
                  background:C.blueLight, border:`1px solid ${C.blueBorder}`, borderRadius:999, padding:"3px 10px", fontWeight:500 }}>
                🔗 {entry.drive_link_label || "Linked document"} ↗
              </a>
            )}
            {entry.call_result && !dealLabel && <Pill style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:9, marginTop:4 }}>{entry.call_result}</Pill>}
            {entry.meeting_place && !dealLabel && <div style={{ fontSize:10, color:C.textMuted, marginTop:3 }}>📍 {entry.meeting_place}</div>}
            {entry.email_subject && !dealLabel && <div style={{ fontSize:10, color:C.textMuted, marginTop:3 }}>Subject: {entry.email_subject}</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ── DEAL TASKS TAB ──
function DealTasksTab({ deal, state, dispatch, readOnly }) {
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState("normal");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [showMeta, setShowMeta] = useState(false);

  const tasks = Object.values(state.tasks)
    .filter(t => t.card_id === deal.id && t.status !== "archived")
    .sort((a,b) => {
      if (a.status === "completed" && b.status !== "completed") return 1;
      if (b.status === "completed" && a.status !== "completed") return -1;
      if (isOverdue(a.due_date) && !isOverdue(b.due_date)) return -1;
      if (!isOverdue(a.due_date) && isOverdue(b.due_date)) return 1;
      return new Date(a.due_date||"9999") - new Date(b.due_date||"9999");
    });

  const addTask = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const task = {
        id: genId(), title: title.trim(), description: description.trim(),
        due_date: dueDate||null, priority, status:"not_started",
        card_id: deal.id, card_type:"deal", subtasks:[], created_at: nowISO()
      };
      await sb.insert("tasks", task);
      dispatch({ type:"ADD_TASK", task });
      await logTaskEvent(dispatch, task, "task_created");
      setTitle(""); setDueDate(""); setPriority("normal"); setDescription("");
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const toggleTask = async (task) => {
    const newStatus = task.status === "completed" ? "not_started" : "completed";
    const updates = { status: newStatus, completed_at: newStatus === "completed" ? nowISO() : null };
    try {
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
      // Promote deal to top of board lane
      const now = nowISO();
      await sb.update("deals", deal.id, { updated_at: now });
      dispatch({ type:"UPDATE_DEAL", id:deal.id, updates:{ updated_at: now } });
    } catch (e) { console.error(e); }
  };

  const deleteTask = async (id) => {
    try {
      await sb.delete("tasks", id);
      dispatch({ type:"DELETE_TASK", id });
      if (expandedId === id) setExpandedId(null);
    } catch (e) { console.error(e); }
  };

  return (
    <div style={{ padding:14, display:"flex", flexDirection:"column", gap:12 }}>
      {/* Add task form — hidden when readOnly */}
      {!readOnly && (
        <div style={{ background:C.tealLight, borderRadius:8, padding:10, border:`0.5px solid ${C.tealBorder}` }}>
          <SectionLabel>New task</SectionLabel>
          <input placeholder="Task title…" value={title} onChange={e => setTitle(e.target.value)}
            style={{ width:"100%", border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"6px 8px", fontSize:12, fontFamily:"inherit", outline:"none", marginBottom:7, background:"white", color:C.text }}
            onKeyDown={e => { if (e.key === "Enter") addTask(); }} />
          <textarea dir="ltr" placeholder="Description (optional)…" value={description} onChange={e => setDescription(e.target.value)} rows={2}
            style={{ width:"100%", border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"6px 8px", fontSize:11, fontFamily:"inherit", outline:"none", marginBottom:7, background:"white", color:C.text, resize:"none" }} />
          <div style={{ display:"flex", gap:6, marginBottom:7 }}>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
              style={{ flex:1, border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", background:"white", color:C.text }} />
            <select value={priority} onChange={e => setPriority(e.target.value)}
              style={{ flex:1, border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", outline:"none", background:"white", color:C.text, appearance:"none" }}>
              {PRIORITIES.map(p => <option key={p} value={p}>{PRI_WORD[p]}</option>)}
            </select>
          </div>
          <div style={{ display:"flex", justifyContent:"flex-end" }}>
            <Btn variant="solid" onClick={addTask}>{saving ? "Saving…" : "Save task"}</Btn>
          </div>
        </div>
      )}

      {/* Metadata toggle bar */}
      {tasks.length > 0 && (
        <div style={{ display:"flex", justifyContent:"flex-end", alignItems:"center", gap:6, marginBottom:-4 }}>
          <span style={{ fontSize:10, color:C.textMuted }}>Show metadata</span>
          <div onClick={() => setShowMeta(v => !v)} style={{
            width:28, height:16, borderRadius:8,
            background: showMeta ? C.teal : C.borderMid,
            position:"relative", transition:"background 0.2s", cursor:"pointer", flexShrink:0
          }}>
            <div style={{
              width:12, height:12, background:"white", borderRadius:"50%",
              position:"absolute", top:2,
              transform: showMeta ? "translateX(14px)" : "translateX(2px)",
              transition:"transform 0.2s"
            }} />
          </div>
        </div>
      )}

      {/* Task list */}
      {tasks.length === 0 ? (
        <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No tasks for this deal</div>
      ) : tasks.map(task => (
        <DealTaskRow key={task.id} task={task}
          state={state}
          dealId={deal.id}
          expanded={expandedId === task.id}
          onToggleExpand={() => setExpandedId(expandedId === task.id ? null : task.id)}
          onToggleComplete={readOnly ? () => {} : () => toggleTask(task)}
          onDelete={readOnly ? null : () => deleteTask(task.id)}
          dispatch={dispatch}
          readOnly={readOnly}
          showMeta={showMeta}
        />
      ))}
    </div>
  );
}

function DealTaskRow({ task, expanded, onToggleExpand, onToggleComplete, onDelete, dispatch, readOnly, state, dealId, showMeta }) {
  const { confirmEl: rowConfirmEl, confirm: rowConfirm } = useConfirm();
  const [editTitle, setEditTitle] = useState(task.title||"");
  const [editDesc, setEditDesc] = useState(task.description||"");
  const [editResolution, setEditResolution] = useState(task.resolution||"");
  const [editDue, setEditDue] = useState(task.due_date||"");
  const [editPriority, setEditPriority] = useState(task.priority||"normal");
  const [saving, setSaving] = useState(false);
  const [showResolutionPrompt, setShowResolutionPrompt] = useState(false);
  const [resolutionText, setResolutionText] = useState("");
  // Note entry state
  const [noteText, setNoteText] = useState("");
  const [noteChannel, setNoteChannel] = useState("Note");
  const [noteTyping, setNoteTyping] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteDriveLink, setNoteDriveLink] = useState("");
  const [noteDriveLinkLabel, setNoteDriveLinkLabel] = useState("");

  const done = task.status === "completed";
  const overdue = !done && isOverdue(task.due_date);
  const dueToday = !done && isToday(task.due_date);
  const circleBorder = overdue ? C.red : dueToday ? C.green : C.borderMid;
  const dateColour = overdue ? C.red : dueToday ? C.green : C.textMuted;
  const notes = state ? Object.values(state.threads || {})
    .filter(e => e.card_id === task.id && e.card_type === "task")
    .sort((a,b) => new Date(a.created_at) - new Date(b.created_at)) : [];
  const noteCount = notes.length;

  const handleCompleteClick = () => {
    if (done) { onToggleComplete(); }
    else { setShowResolutionPrompt(true); setResolutionText(""); }
  };

  const confirmComplete = async () => {
    setSaving(true);
    try {
      const updates = { status:"completed", resolution: resolutionText.trim()||null, completed_at: nowISO() };
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
      await logTaskEvent(dispatch, task, "task_completed", { resolution: resolutionText.trim() || null });
      if (dealId) {
        const now = nowISO();
        await sb.update("deals", dealId, { updated_at: now });
        dispatch({ type:"UPDATE_DEAL", id:dealId, updates:{ updated_at: now } });
      }
      setShowResolutionPrompt(false);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const saveField = async (field, value) => {
    try {
      const updates = { [field]: value || null };
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
    } catch(e) { console.error(e); }
  };

  const addNote = async () => {
    if (!noteText.trim()) return;
    setNoteSaving(true);
    try {
      const entry = {
        id: genId(), card_id: task.id, card_type: "task",
        channel: noteChannel, text: noteText.trim(),
        is_system_event: false, created_at: nowISO()
      };
      // Attempt to include drive_link fields — silently omit if column doesn't exist
      if (noteDriveLink.trim()) {
        try {
          const testEntry = { ...entry, drive_link: noteDriveLink.trim(), drive_link_label: noteDriveLinkLabel.trim() || null };
          await sb.insert("thread_entries", testEntry);
          dispatch({ type:"ADD_THREAD", entry: testEntry });
        } catch(e2) {
          await sb.insert("thread_entries", entry);
          dispatch({ type:"ADD_THREAD", entry });
        }
        // Echo into the deal's Activity timeline so the document is
        // visible at deal level (and caught by the document filter)
        await logTaskEvent(dispatch, task, "task_doc", { drive_link: noteDriveLink.trim(), drive_link_label: noteDriveLinkLabel.trim() || null });
      } else {
        await sb.insert("thread_entries", entry);
        dispatch({ type:"ADD_THREAD", entry });
      }
      if (dealId) {
        const now = nowISO();
        await sb.update("deals", dealId, { updated_at: now });
        dispatch({ type:"UPDATE_DEAL", id:dealId, updates:{ updated_at: now } });
      }
      setNoteText(""); setNoteChannel("Note"); setNoteTyping(false);
      setNoteDriveLink(""); setNoteDriveLinkLabel("");
    } catch(e) { console.error(e); }
    setNoteSaving(false);
  };

  const deleteTask = async () => {
    if (!await rowConfirm(`Delete "${task.title}"?`)) return;
    onDelete();
  };

  const archiveTask = async () => {
    if (!await rowConfirm(`Archive "${task.title}"?`)) return;
    setSaving(true);
    try {
      const updates = { status:"archived" };
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
      await logTaskEvent(dispatch, task, "task_archived");
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  return (
    <div style={{ borderBottom:`0.5px solid ${C.border}` }}>
      {/* Collapsed header row */}
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", cursor:"pointer" }}
        onClick={onToggleExpand}>
        {/* Completion circle */}
        <div onClick={e => { e.stopPropagation(); handleCompleteClick(); }} style={{
          width:16, height:16, borderRadius:"50%", flexShrink:0,
          border: done ? "none" : `1.5px solid ${circleBorder}`,
          background: done ? C.teal : "transparent",
          display:"flex", alignItems:"center", justifyContent:"center",
          cursor: done ? "default" : "pointer",
          onMouseEnter: e => { if (!done) e.currentTarget.style.borderColor = C.green; },
        }}>
          {done && <span style={{ color:"white", fontSize:10 }}>✓</span>}
        </div>
        {/* Title + meta */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:11, fontWeight:500,
            color: done ? C.textDim : C.text,
            textDecoration: done ? "line-through" : "none",
            whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
            {task.title}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:2 }}>
            {PRI_STARS[task.priority] > 0 && (
              <span title={`${PRI_WORD[task.priority]} priority`} style={{ fontSize:13, fontWeight:900, color: PRI_STAR_COLOUR[task.priority], lineHeight:1 }}>
                {"*".repeat(PRI_STARS[task.priority])}
              </span>
            )}
            {task.due_date && (
              <span style={{ fontSize:10, color: done ? C.textDim : dateColour,
                fontWeight: (overdue || dueToday) && !done ? 500 : 400 }}>
                {dueToday && !done ? "Today" : overdue && !done ? `${fmtDate(task.due_date)} · overdue` : fmtDate(task.due_date)}
              </span>
            )}
            {noteCount > 0 && (
              <span title={`${noteCount} progress note${noteCount !== 1 ? "s" : ""}`}
                style={{ fontSize:9, color:C.textMuted, display:"inline-flex", alignItems:"center", gap:2 }}>
                <i className="ti ti-notes" style={{ fontSize:10 }} /> {noteCount}
              </span>
            )}
          </div>
          {showMeta && (
            <div style={{ display:"flex", gap:10, marginTop:3 }}>
              {task.created_at && (
                <span style={{ fontSize:9, color:C.textDim }}>
                  Created {fmtDate(task.created_at)}
                </span>
              )}
              {task.updated_at && task.updated_at !== task.created_at && (
                <span style={{ fontSize:9, color:C.textDim }}>
                  · Updated {fmtDate(task.updated_at)}
                </span>
              )}
              {task.completed_at && (
                <span style={{ fontSize:9, color:C.textDim }}>
                  · Completed {fmtDate(task.completed_at)}
                </span>
              )}
            </div>
          )}
        </div>
        {/* Chevron — bordered button */}
        <span onMouseEnter={e => { e.currentTarget.style.color = C.text; }}
          onMouseLeave={e => { e.currentTarget.style.color = C.textDim; }}
          style={{
          fontSize:13, color:C.textDim, flexShrink:0, display:"inline-block",
          transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
          transition:"transform 0.15s, color 0.12s"
        }}>⌄</span>
      </div>

      {/* Resolution prompt — inline, not in expanded area */}
      {showResolutionPrompt && (
        <div style={{ marginBottom:8, marginLeft:24, background:C.greenLight,
          border:`0.5px solid ${C.greenBorder}`, borderRadius:7, padding:"10px 12px",
          display:"flex", flexDirection:"column", gap:7 }}>
          <div style={{ fontSize:11, fontWeight:500, color:C.green }}>
            How was this resolved? <span style={{ fontWeight:400, color:C.textMuted }}>(optional)</span>
          </div>
          <textarea dir="ltr" autoFocus value={resolutionText}
            onChange={e => setResolutionText(e.target.value)}
            placeholder="e.g. CJ confirmed — closing this chase"
            rows={2}
            style={{ width:"100%", border:`0.5px solid ${C.greenBorder}`, borderRadius:5,
              padding:"6px 8px", fontSize:11, fontFamily:"inherit", resize:"none",
              outline:"none", color:C.text, lineHeight:1.5 }} />
          <div style={{ display:"flex", gap:5, justifyContent:"flex-end" }}>
            <Btn onClick={() => setShowResolutionPrompt(false)}>Cancel</Btn>
            <Btn style={{ background:C.green, color:"#fff", borderColor:C.green }} onClick={confirmComplete}>
              {saving ? "Saving…" : "Mark complete"}
            </Btn>
          </div>
        </div>
      )}

      {/* Expanded area */}
      {expanded && (
        <div style={{ marginLeft:24, marginBottom:10, border:`0.5px solid ${C.border}`,
          borderRadius:8, overflow:"hidden" }}>

          {/* Description */}
          {task.description && (
            <div style={{ padding:"8px 10px 6px", borderBottom:`0.5px solid ${C.border}` }}>
              <SectionLabel>Description</SectionLabel>
              <div style={{ fontSize:11, color:C.text, lineHeight:1.6,
                whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{task.description}</div>
            </div>
          )}

          {/* Resolution (completed tasks) */}
          {task.resolution && (
            <div style={{ padding:"8px 10px 6px", background:C.greenLight,
              borderBottom:`0.5px solid ${C.greenBorder}` }}>
              <SectionLabel>Resolution</SectionLabel>
              <div style={{ fontSize:11, color:C.text, lineHeight:1.6,
                whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{task.resolution}</div>
            </div>
          )}

          {/* Progress notes thread */}
          {notes.length > 0 && (
            <div style={{ padding:"8px 10px 0", borderBottom:`0.5px solid ${C.border}` }}>
              <SectionLabel>Progress notes</SectionLabel>
              <div style={{ display:"flex", flexDirection:"column" }}>
                {notes.map((note, idx) => {
                  const col = CH_COLOUR[note.channel];
                  const icon = CH_ICON[note.channel];
                  const isLast = idx === notes.length - 1;
                  return (
                    <div key={note.id} style={{ display:"flex", gap:8, alignItems:"flex-start",
                      paddingBottom: isLast ? 8 : 6,
                      borderBottom: isLast ? "none" : `0.5px solid ${C.border}`,
                      marginBottom: isLast ? 0 : 0 }}>
                      {/* Icon or dot */}
                      {icon ? (
                        <div style={{ width:16, height:16, borderRadius:"50%", flexShrink:0,
                          background: col?.bg, border:`0.5px solid ${col?.border}`,
                          display:"flex", alignItems:"center", justifyContent:"center", marginTop:2 }}>
                          <i className={`ti ${icon}`} style={{ fontSize:8, color:col?.text }} />
                        </div>
                      ) : (
                        <div style={{ width:8, height:8, borderRadius:"50%",
                          background:C.tealBorder, flexShrink:0, marginTop:5 }} />
                      )}
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:9, color:C.textDim, marginBottom:1 }}>
                          {fmtDate(note.created_at)} · {fmtTime(note.created_at)}
                        </div>
                        <div style={{ fontSize:11, color:C.text, lineHeight:1.5 }}>{note.text}</div>
                        {note.drive_link && (
                          <a href={note.drive_link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                            style={{ fontSize:9, color:C.blue, textDecoration:"none", cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3, marginTop:3,
                              background:C.blueLight, border:`1px solid ${C.blueBorder}`, borderRadius:999, padding:"2px 8px", fontWeight:500 }}>
                            🔗 {note.drive_link_label || "Linked document"} ↗
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Add note — reveal-on-type channel selector */}
          {!readOnly && !done && (
            <div style={{ padding:"8px 10px", borderBottom:`0.5px solid ${C.border}` }}>
              <textarea
                dir="ltr"
                value={noteText}
                onChange={e => {
                  setNoteText(e.target.value);
                  if (e.target.value.length > 0 && !noteTyping) setNoteTyping(true);
                  if (e.target.value.length === 0) { setNoteTyping(false); setNoteChannel("Note"); }
                }}
                placeholder="Add a progress note…"
                rows={2}
                onKeyDown={e => { if (e.key === "Enter" && e.metaKey) addNote(); }}
                style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6,
                  padding:"6px 8px", fontSize:11, fontFamily:"system-ui,sans-serif",
                  resize:"none", outline:"none", color:C.text, lineHeight:1.5 }}
              />
              {/* Channel selector — reveal on type */}
              <div style={{
                display:"flex", alignItems:"center", gap:5, marginTop:5,
                maxHeight: noteTyping ? 28 : 0, opacity: noteTyping ? 1 : 0,
                overflow:"hidden", transition:"max-height 0.18s ease, opacity 0.15s ease"
              }}>
                <span style={{ fontSize:9, color:C.textDim }}>Type:</span>
                {CHANNELS.map(ch => {
                  const col = CH_COLOUR[ch];
                  const isActive = noteChannel === ch;
                  return (
                    <span key={ch} onClick={() => setNoteChannel(ch)} title={ch} style={{
                      width:20, height:20, borderRadius:"50%", flexShrink:0,
                      background: isActive ? col.border : col.bg,
                      border:`1px solid ${isActive ? col.text : col.border}`,
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      cursor:"pointer", boxShadow: isActive ? `0 0 0 2px ${col.border}` : "none"
                    }}>
                      <i className={`ti ${CH_ICON[ch]}`} style={{ fontSize:10, color:col.text, opacity: isActive ? 1 : 0.55 }} />
                    </span>
                  );
                })}
              </div>
              {/* Attach document — reveal on type (v9.3.96) */}
              <div style={{
                maxHeight: noteTyping ? 90 : 0, opacity: noteTyping ? 1 : 0,
                overflow:"hidden", transition:"max-height 0.18s ease, opacity 0.15s ease"
              }}>
                <div style={{ marginTop:5, background:C.bgSecondary, border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"6px 8px" }}>
                  <div style={{ fontSize:9, color:C.textMuted, marginBottom:4, fontWeight:500 }}>📎 Attach document (optional)</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <input placeholder="Label e.g. Certificate of Analysis" value={noteDriveLinkLabel} onChange={e => setNoteDriveLinkLabel(e.target.value)}
                      style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:5, padding:"3px 7px", fontSize:10, fontFamily:"inherit", outline:"none", color:C.text }} />
                    <input placeholder="https://docs.google.com/… (URL)" value={noteDriveLink} onChange={e => setNoteDriveLink(e.target.value)}
                      style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:5, padding:"3px 7px", fontSize:10, fontFamily:"inherit", outline:"none", color:C.text }} />
                  </div>
                </div>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:5 }}>
                <span style={{ fontSize:9, color:C.textDim }}>⌘ + Enter to save</span>
                <Btn variant="teal" onClick={addNote} style={{ fontSize:10, padding:"3px 10px" }}>
                  {noteSaving ? "Saving…" : "Add note"}
                </Btn>
              </div>
            </div>
          )}

          {/* Action strip — two lines: properties, then actions (v9.3.102) */}
          {!readOnly && !done && (
            <div style={{ padding:"7px 12px", background:C.bgSecondary, display:"flex", flexDirection:"column", gap:7 }}>
              {/* Line 1 — properties: priority | date */}
              <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                {PRIORITIES.map(p => {
                  const sel = editPriority === p;
                  const pc = PRI_STAR_COLOUR[p] || C.textMuted;
                  return (
                    <span key={p} onClick={() => saveField("priority", p)} title={`${PRI_WORD[p]} priority`}
                      onMouseEnter={e => { if (!sel) e.currentTarget.style.color = pc; }}
                      onMouseLeave={e => { if (!sel) e.currentTarget.style.color = C.textDim; }}
                      style={{
                        fontSize:13, lineHeight:1, cursor:"pointer", userSelect:"none",
                        fontWeight: sel ? 900 : 600,
                        color: sel ? pc : C.textDim,
                        transition:"color 0.12s",
                      }}>
                      {PRI_STARS[p] > 0 ? "*".repeat(PRI_STARS[p]) : "–"}
                    </span>
                  );
                })}
                <div style={{ width:"0.5px", height:14, background:C.borderMid }} />
                <input type="date" value={editDue}
                  onChange={e => { setEditDue(e.target.value); saveField("due_date", e.target.value); }}
                  style={{ border:"none", borderBottom:`0.5px solid ${C.borderMid}`, borderRadius:0,
                    padding:"2px 2px", fontSize:10, fontFamily:"inherit",
                    outline:"none", color: editDue ? C.text : C.textDim,
                    background:"transparent", cursor:"pointer" }} />
              </div>
              {/* Line 2 — actions: complete left, destructive isolated right */}
              <div style={{ display:"flex", alignItems:"center" }}>
                <span onClick={handleCompleteClick} title="Mark complete"
                  onMouseEnter={e => { e.currentTarget.style.filter = "brightness(0.8)"; }}
                  onMouseLeave={e => { e.currentTarget.style.filter = "none"; }}
                  style={{ width:24, height:22, display:"inline-flex", alignItems:"center", justifyContent:"center",
                    cursor:"pointer", color:C.green, fontSize:15, transition:"filter 0.12s" }}>
                  <i className="ti ti-circle-check" aria-hidden="true" />
                </span>
                <div style={{ flex:1 }} />
                <span onClick={archiveTask} title="Archive task"
                  onMouseEnter={e => { e.currentTarget.style.color = C.text; }}
                  onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; }}
                  style={{ width:24, height:22, display:"inline-flex", alignItems:"center", justifyContent:"center",
                    cursor:"pointer", color:C.textMuted, fontSize:14, transition:"color 0.12s" }}>
                  <i className="ti ti-archive" aria-hidden="true" />
                </span>
                <span onClick={deleteTask} title="Delete task"
                  onMouseEnter={e => { e.currentTarget.style.color = C.red; }}
                  onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; }}
                  style={{ width:24, height:22, display:"inline-flex", alignItems:"center", justifyContent:"center",
                    cursor:"pointer", color:C.textMuted, fontSize:14, marginLeft:6, transition:"color 0.12s" }}>
                  <i className="ti ti-trash" aria-hidden="true" />
                </span>
              </div>
            </div>
          )}

          {/* Completed timestamp */}
          {done && task.completed_at && (
            <div style={{ padding:"6px 10px", fontSize:10, color:C.textDim }}>
              ✓ Completed {fmtDate(task.completed_at)} at {new Date(task.completed_at).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}
            </div>
          )}
        </div>
      )}
      {rowConfirmEl}
    </div>
  );
}




// ── TASKS SCREEN ──
function TasksScreen({ state, dispatch, searchNav, onNavigate }) {
  const [filterPriority, setFilterPriority] = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showFloating, setShowFloating] = useState(true);
  const [showCompleted, setShowCompleted] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [completingTaskId, setCompletingTaskId] = useState(null);
  const [completionResolution, setCompletionResolution] = useState("");
  const [completionSaving, setCompletionSaving] = useState(false);
  const [showMeta, setShowMeta] = useState(false);

  const startCompletion = (taskId, e) => {
    e.stopPropagation(); // don't also select the task
    if (completingTaskId === taskId) { setCompletingTaskId(null); setCompletionResolution(""); return; }
    setCompletingTaskId(taskId);
    setCompletionResolution("");
  };

  const confirmCompletion = async (taskId) => {
    setCompletionSaving(true);
    try {
      const updates = { status:"completed", resolution: completionResolution.trim() || null, completed_at: nowISO() };
      await sb.update("tasks", taskId, updates);
      dispatch({ type:"UPDATE_TASK", id:taskId, updates });
      const completedTask = state.tasks[taskId];
      if (completedTask) await logTaskEvent(dispatch, completedTask, "task_completed", { resolution: completionResolution.trim() || null });
      // If this task was open in the detail pane, deselect it —
      // completing removes it from the active list so the panel
      // would be showing a task that no longer appears in the list.
      if (selectedTaskId === taskId) setSelectedTaskId(null);
      setCompletingTaskId(null);
      setCompletionResolution("");
    } catch(e) { console.error(e); }
    setCompletionSaving(false);
  };
  // Global collapse toggle for subtask groups (v9.3.43). Expanded by
  // default so nothing is hidden on load — the toggle is opt-in for
  // Per-section collapse state (v9.3.44). All sections open by default.
  // Keys match section names used in SectionHeader calls below.
  // Completed starts closed since it's the least time-sensitive section
  // and most likely to be noise during a working session.
  const [sectionOpen, setSectionOpen] = useState({
    overdue: true, today: true, upcoming: true, nodate: true,
    completed: false, archived: false,
  });
  const toggleSection = (key) => setSectionOpen(s => ({ ...s, [key]: !s[key] }));

  const [filterCardId, setFilterCardId] = useState(null);
  const [taskSearch, setTaskSearch] = useState("");

  useEffect(() => {
    if (searchNav?.selectedId) { setSelectedTaskId(searchNav.selectedId); setShowAddForm(false); }
    if (searchNav?.filterCardId) { setFilterCardId(searchNav.filterCardId); setSelectedTaskId(null); setTaskSearch(""); }
  }, [searchNav]);

  // Add task form state
  const [newTitle, setNewTitle] = useState("");
  const [newDueDate, setNewDueDate] = useState("");
  const [newPriority, setNewPriority] = useState("normal");
  const [newDescription, setNewDescription] = useState("");
  const [newDealId, setNewDealId] = useState("");
  const [saving, setSaving] = useState(false);

  const taskSearchLower = taskSearch.toLowerCase().trim();
  const allTasks = Object.values(state.tasks).filter(t => {
    if (t.status === "archived") return false;
    if (filterCardId && t.card_id !== filterCardId) return false;
    if (!showFloating && !t.card_id) {
      const overdue = isOverdue(t.due_date) && t.status !== "completed";
      if (!overdue) return false;
    }
    if (taskSearchLower) {
      const deal = t.card_id ? state.deals[t.card_id] : null;
      const searchable = [
        t.title,
        t.description,
        deal?.deal_name,
        deal?.commodity,
        deal?.location,
      ].filter(Boolean).join(" ").toLowerCase();
      if (!searchable.includes(taskSearchLower)) return false;
    }
    return true;
  });

  const filtered = filterPriority === "all" ? allTasks : allTasks.filter(t => t.priority === filterPriority);

  // Archived tasks are excluded from allTasks at the source (status === "archived"
  // is filtered out above) — derive separately here, mirroring the same card,
  // priority, and search filters so the section respects whatever the person
  // is currently filtering by, rather than always showing every archived task.
  const archivedTasks = showArchived
    ? Object.values(state.tasks).filter(t => {
        if (t.status !== "archived") return false;
        if (filterCardId && t.card_id !== filterCardId) return false;
        if (filterPriority !== "all" && t.priority !== filterPriority) return false;
        if (taskSearchLower) {
          const deal = t.card_id ? state.deals[t.card_id] : null;
          const searchable = [
            t.title,
            t.description,
            deal?.deal_name,
            deal?.commodity,
            deal?.location,
          ].filter(Boolean).join(" ").toLowerCase();
          if (!searchable.includes(taskSearchLower)) return false;
        }
        return true;
      }).sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
    : [];

  const today = todayStr();
  // Sort functions (v9.3.67 — previously all sections used priSort alone,
  // which meant a high-priority task due in 3 weeks ranked above a normal
  // task due tomorrow. Fixed: date is always the primary sort key; priority
  // is a tiebreaker within the same date only.)
  //
  // Upcoming: soonest date first, then priority within same date.
  const dateAscPriSort = (a, b) => {
    const dA = a.due_date || "", dB = b.due_date || "";
    if (dA !== dB) return dA < dB ? -1 : 1;
    return (PRI_ORDER[a.priority] ?? 2) - (PRI_ORDER[b.priority] ?? 2);
  };
  // Overdue: most overdue first (oldest date), then priority within same date.
  // Surfaces longest-ignored items at the top as a reminder.
  const dateAscPriSortOverdue = dateAscPriSort; // same logic, oldest = smallest date = first
  // Today and no-date: no date distinction possible, so priority alone.
  const priSort = (a, b) => (PRI_ORDER[a.priority] ?? 2) - (PRI_ORDER[b.priority] ?? 2);

  // Flat section arrays — tasks only, no subtask rows, no parent grouping.
  // Each task belongs to its card; the ↗ card pill on TaskRow provides context.
  const overdueSection   = filtered.filter(t => t.status !== "completed" && isOverdue(t.due_date)).sort(dateAscPriSortOverdue);
  const todaySection     = filtered.filter(t => t.status !== "completed" && isToday(t.due_date)).sort(priSort);
  const upcomingSection  = filtered.filter(t => t.status !== "completed" && t.due_date && t.due_date > today).sort(dateAscPriSort);
  const noDateSection    = filtered.filter(t => t.status !== "completed" && !t.due_date).sort(priSort);
  const completedSection = showCompleted ? filtered.filter(t => t.status === "completed").sort(dateAscPriSort) : [];

  const overdue    = overdueSection;
  const todayTasks = todaySection;
  const upcoming   = upcomingSection;
  const noDate     = noDateSection;
  const completed  = completedSection;

  const selectTask = (id) => { setSelectedTaskId(id); setShowAddForm(false); };
  const deals = Object.values(state.deals);
  const dealName = (id) => { const d = state.deals[id]; return d ? (d.deal_name || d.name || id) : null; };
  const openAddForm = () => {
    setShowAddForm(true); setSelectedTaskId(null);
    // Inherit the active card focus: if the registry is filtered to a
    // card, a new task should default to that card, not to floating.
    // (v9.3.96 — root cause of tasks created from a card-focused
    // registry silently saving unlinked)
    if (filterCardId) setNewDealId(filterCardId);
  };

  const saveTask = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      const task = {
        id: genId(),
        title: newTitle.trim(),
        description: newDescription.trim(),
        due_date: newDueDate || null,
        priority: newPriority,
        status: "not_started",
        card_id: newDealId || null,
        card_type: newDealId ? "deal" : null,
        subtasks: [],
        created_at: nowISO(),
      };
      await sb.insert("tasks", task);
      dispatch({ type:"ADD_TASK", task });
      await logTaskEvent(dispatch, task, "task_created");
      setNewTitle(""); setNewDueDate(""); setNewPriority("normal"); setNewDescription(""); setNewDealId("");
      setShowAddForm(false);
      setSelectedTaskId(task.id);
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const selectedTask = selectedTaskId ? state.tasks[selectedTaskId] : null;

  const PRI_BAR = { urgent: C.red, high: C.amber, normal: C.blue, low: C.textDim };

  function TaskRow({ task, section }) {
    const dn = task.card_id ? dealName(task.card_id) : null;
    const archived = task.status === "archived";
    const overdue = task.status !== "completed" && !archived && isOverdue(task.due_date);
    const dueToday = task.status !== "completed" && !archived && isToday(task.due_date);
    const done = task.status === "completed";
    const dateColour = overdue ? C.red : dueToday ? C.green : C.textMuted;
    const stars = PRI_STARS[task.priority] || 0;
    const isCompleting = completingTaskId === task.id;
    return (
      <>
      <div onClick={() => selectTask(task.id)} style={{
        display:"flex", alignItems:"flex-start", gap:8, padding:"8px 14px",
        borderBottom: isCompleting ? "none" : `0.5px solid ${C.border}`,
        background: selectedTaskId === task.id ? (task.card_type === "lead" ? C.orangeLight : C.tealLight) : "transparent",
        cursor:"pointer", opacity: (done || archived) ? 0.6 : 1,
      }}
      onMouseEnter={e => { if (selectedTaskId !== task.id) e.currentTarget.style.background = C.bgSecondary; }}
      onMouseLeave={e => { if (selectedTaskId !== task.id) e.currentTarget.style.background = "transparent"; }}>
        {/* Circle: now a real completion click target */}
        <div onClick={e => !done && !archived && startCompletion(task.id, e)}
          style={{ width:16, height:16, borderRadius:"50%", flexShrink:0, marginTop:1,
          border: done ? "none" : `1.5px solid ${archived ? C.textDim : isCompleting ? C.green : C.borderMid}`,
          background: done ? C.teal : isCompleting ? C.greenLight : "transparent",
          display:"flex", alignItems:"center", justifyContent:"center",
          cursor: done || archived ? "default" : "pointer",
          transition:"border-color 0.12s, background 0.12s" }}>
          {done && <span style={{ color:"white", fontSize:10 }}>✓</span>}
          {archived && !done && <span style={{ color:C.textDim, fontSize:9 }}>🗄</span>}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:11, fontWeight:500, color: (done || archived) ? C.textMuted : C.text,
            textDecoration: done ? "line-through" : "none", marginBottom:2 }}>
            {task.title}
          </div>
          {dn && (
            <div style={{ display:"inline-flex", alignItems:"center", gap:3,
              fontSize:9, color:C.textMuted, background:C.bgSecondary,
              border:`0.5px solid ${C.borderMid}`, borderRadius:4,
              padding:"1px 5px", marginBottom:3 }}>
              ↗ {dn}
            </div>
          )}
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            {stars > 0 && (
              <span title={`${PRI_WORD[task.priority]} priority`} style={{ fontSize:13, fontWeight:900, color: PRI_STAR_COLOUR[task.priority], lineHeight:1 }}>
                {"*".repeat(stars)}
              </span>
            )}
            {task.due_date && (
              <span style={{ fontSize:10, color: archived ? C.textDim : dateColour,
                fontWeight: (overdue || dueToday) ? 500 : 400 }}>
                {dueToday ? "Today" : overdue ? `${fmtDate(task.due_date)} · overdue` : fmtDate(task.due_date)}
              </span>
            )}
          </div>
          {showMeta && (
            <div style={{ display:"flex", gap:8, marginTop:3 }}>
              {task.created_at && (
                <span style={{ fontSize:9, color:C.textDim }}>Created {fmtDate(task.created_at)}</span>
              )}
              {task.updated_at && task.updated_at !== task.created_at && (
                <span style={{ fontSize:9, color:C.textDim }}>· Updated {fmtDate(task.updated_at)}</span>
              )}
              {task.completed_at && (
                <span style={{ fontSize:9, color:C.textDim }}>· Completed {fmtDate(task.completed_at)}</span>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Inline resolution prompt — appears below this row when circle clicked */}
      {isCompleting && (
        <div style={{ padding:"8px 14px 10px", borderBottom:`0.5px solid ${C.border}`,
          background:C.greenLight, borderLeft:`2px solid ${C.green}` }}>
          <div style={{ fontSize:10, fontWeight:500, color:C.green, marginBottom:5 }}>
            How was this resolved? <span style={{ fontWeight:400, color:C.textMuted }}>(optional)</span>
          </div>
          <textarea
            autoFocus
            value={completionResolution}
            onChange={e => setCompletionResolution(e.target.value)}
            placeholder="e.g. Called and confirmed, waiting on docs"
            rows={2}
            style={{ width:"100%", border:`0.5px solid ${C.greenBorder}`, borderRadius:6,
              padding:"5px 8px", fontSize:11, fontFamily:"inherit", resize:"none",
              color:C.text, outline:"none", lineHeight:1.5, marginBottom:6 }}
          />
          <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
            <Btn onClick={() => { setCompletingTaskId(null); setCompletionResolution(""); }}>Cancel</Btn>
            <Btn style={{ background:C.green, color:"#fff", borderColor:C.green, padding:"4px 12px", fontSize:10 }}
              onClick={() => confirmCompletion(task.id)}>
              {completionSaving ? "Saving…" : "Mark complete"}
            </Btn>
          </div>
        </div>
      )}
      </>
    );
  }


  function SectionHeader({ label, icon, count, colour, pillStyle, isOpen, onToggle }) {
    return (
      <div onClick={onToggle} style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"7px 14px 4px", borderBottom:`0.5px solid ${C.border}`,
        position:"sticky", top:0, background:"white", zIndex:1,
        cursor:"pointer", userSelect:"none" }}
        onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
        onMouseLeave={e => e.currentTarget.style.background = "white"}>
        <span style={{ fontSize:10, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.07em",
          color:colour, display:"flex", alignItems:"center", gap:5 }}>
          {icon} {label}
        </span>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <Pill style={{ fontSize:9, padding:"1px 7px", ...pillStyle }}>{count}</Pill>
          <span style={{
            fontSize:10, color:C.textMuted, lineHeight:1, display:"inline-block",
            transform: isOpen ? "rotate(0deg)" : "rotate(-90deg)",
            transition:"transform 0.15s ease",
          }}>▾</span>
        </div>
      </div>
    );
  }

  const [leftWidth, onDragLeft] = useDraggablePanel(300, 200, 520);

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>

      {/* ── LEFT PANEL ── */}
      <div style={{ width:leftWidth, borderRight:"none", display:"flex", flexDirection:"column", flexShrink:0 }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader }}>
          <span style={{ fontSize:13, fontWeight:500, color:C.text }}>Tasks</span>
          <Pill onClick={openAddForm} style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:10, padding:"3px 11px", cursor:"pointer" }}>+ Add task</Pill>
        </div>

        {/* Task search */}
        <div style={{ padding:"7px 14px", borderBottom:`0.5px solid ${C.border}` }}>
          <div style={{ position:"relative" }}>
            <span style={{ position:"absolute", left:9, top:"50%", transform:"translateY(-50%)", color:C.textDim, fontSize:12, pointerEvents:"none" }}>
              <i className="ti ti-search" aria-hidden="true" />
            </span>
            <input
              value={taskSearch}
              onChange={e => setTaskSearch(e.target.value)}
              placeholder="Search tasks..."
              style={{
                width:"100%", border:`0.5px solid ${taskSearch ? C.borderMid : C.border}`,
                borderRadius:999, padding:"5px 10px 5px 28px", fontSize:11,
                fontFamily:"inherit", outline:"none", color:C.text,
                background: taskSearch ? C.bg : C.bgSecondary,
                boxSizing:"border-box"
              }}
            />
            {taskSearch && (
              <span onClick={() => setTaskSearch("")} style={{
                position:"absolute", right:9, top:"50%", transform:"translateY(-50%)",
                color:C.textMuted, fontSize:14, cursor:"pointer", lineHeight:1
              }}>×</span>
            )}
          </div>
          {taskSearch && (
            <div style={{ fontSize:10, color:C.textMuted, marginTop:5 }}>
              Searching: <strong style={{ color:C.text }}>{taskSearch}</strong>
            </div>
          )}
        </div>

        {/* Priority filter */}
        <div style={{ padding:"7px 14px", borderBottom:`0.5px solid ${C.border}` }}>
          <SectionLabel>Filter by priority</SectionLabel>
          <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
            {[
              { key:"all",    label:"All",    stars:null,  starColour:null                   },
              { key:"urgent", label:"Urgent", stars:"***", starColour:PRI_STAR_COLOUR.urgent  },
              { key:"high",   label:"High",   stars:"**",  starColour:PRI_STAR_COLOUR.high    },
              { key:"normal", label:"Normal", stars:"*",   starColour:PRI_STAR_COLOUR.normal  },
              { key:"low",    label:"Low",    stars:null,  starColour:null                   },
            ].map(f => (
              <span key={f.key} onClick={() => setFilterPriority(f.key)} style={{
                fontSize:10, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3,
                color: filterPriority === f.key ? C.text : C.textMuted,
                fontWeight: filterPriority === f.key ? 600 : 400,
                borderBottom: filterPriority === f.key ? `1.5px solid ${C.text}` : "1.5px solid transparent",
                paddingBottom:1, userSelect:"none",
              }}>
                {f.stars && <span style={{ fontSize:13, fontWeight:700, color: f.starColour, letterSpacing:1, lineHeight:1 }}>{f.stars}</span>}
                {f.label}
              </span>
            ))}
          </div>
        </div>

        {/* Lead card filter banner */}
        {filterCardId && (() => {
          const ld = state.deals[filterCardId];
          const ldName = ld ? ([ld.commodity, ld.location].filter(Boolean).join(" · ") || ld.deal_name) : filterCardId;
          return (
            <div style={{ padding:"6px 14px", borderBottom:`0.5px solid ${C.border}`, display:"flex", alignItems:"center", gap:8, background:C.orangeLight }}>
              <span style={{ fontSize:11, color:C.orangeDark, fontWeight:500 }}>Showing tasks for Lead: {ldName}</span>
              <span onClick={() => setFilterCardId(null)} style={{ fontSize:11, color:C.orangeDark, cursor:"pointer", marginLeft:"auto", fontWeight:500 }}>✕ Clear</span>
            </div>
          );
        })()}

        {/* Show/hide toggles — plain text, no pills, active = underlined */}
        <div style={{ padding:"6px 14px", borderBottom:`0.5px solid ${C.border}`, display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
          {[
            { label:"Show floating", active:showFloating,   toggle:() => setShowFloating(v => !v),   activeColour:"#5b21b6", title:"Floating tasks are not linked to any deal. Overdue floating tasks always show." },
            { label:"Show metadata", active:showMeta, toggle:() => setShowMeta(v => !v), activeColour:C.textMuted, title:"Show created and updated dates on each task." },
            { label:"Completed", active:showCompleted, activeColour:C.green, toggle:() => {
                const next = !showCompleted;
                setShowCompleted(next);
                if (next) {
                  // Activating completed — collapse all active sections,
                  // expand completed only, close archived
                  setShowArchived(false);
                  setSectionOpen({ overdue:false, today:false, upcoming:false, nodate:false, completed:true, archived:false });
                } else {
                  // Deactivating — restore all active sections
                  setSectionOpen({ overdue:true, today:true, upcoming:true, nodate:true, completed:false, archived:false });
                }
              }},
            { label:"Archived", active:showArchived, activeColour:C.textMuted, toggle:() => {
                const next = !showArchived;
                setShowArchived(next);
                if (next) {
                  // Activating archived — collapse all active sections,
                  // expand archived only, close completed
                  setShowCompleted(false);
                  setSectionOpen({ overdue:false, today:false, upcoming:false, nodate:false, completed:false, archived:true });
                } else {
                  // Deactivating — restore all active sections
                  setSectionOpen({ overdue:true, today:true, upcoming:true, nodate:true, completed:false, archived:false });
                }
              }},
          ].map(f => (
            <span key={f.label} onClick={f.toggle} title={f.title || ""} style={{
              fontSize:10, cursor:"pointer", userSelect:"none",
              color: f.active ? f.activeColour : C.textDim,
              fontWeight: f.active ? 600 : 400,
              borderBottom: f.active ? `1.5px solid ${f.activeColour}` : "1.5px solid transparent",
              paddingBottom:1,
            }}
            onMouseEnter={e => { if (!f.active) e.currentTarget.style.color = C.textMuted; }}
            onMouseLeave={e => { if (!f.active) e.currentTarget.style.color = C.textDim; }}>
              {f.active && "✓ "}{f.label}
            </span>
          ))}
          {!showFloating && (
            <span style={{ fontSize:10, color:C.textDim, fontStyle:"italic" }}>
              Overdue floating tasks still shown
            </span>
          )}
        </div>

        {/* Task list */}
        <div style={{ flex:1, overflowY:"auto" }}>
          {overdueSection.length > 0 && <>
            <SectionHeader label="Overdue" icon="⚠" count={overdueSection.length}
              colour={C.red} pillStyle={{ background:C.redLight, color:C.red, borderColor:C.redBorder }}
              isOpen={sectionOpen.overdue} onToggle={() => toggleSection("overdue")} />
            {sectionOpen.overdue && overdueSection.map(t => <TaskRow key={t.id} task={t} />)}
          </>}
          {todaySection.length > 0 && <>
            <SectionHeader label="Today" icon="★" count={todaySection.length}
              colour={C.green} pillStyle={{ background:C.greenLight, color:C.green, borderColor:C.greenBorder }}
              isOpen={sectionOpen.today} onToggle={() => toggleSection("today")} />
            {sectionOpen.today && todaySection.map(t => <TaskRow key={t.id} task={t} />)}
          </>}
          {upcomingSection.length > 0 && <>
            <SectionHeader label="Upcoming" icon="◷" count={upcomingSection.length}
              colour="#d97706" pillStyle={{ background:"#fffbeb", color:"#d97706", borderColor:"#fde68a" }}
              isOpen={sectionOpen.upcoming} onToggle={() => toggleSection("upcoming")} />
            {sectionOpen.upcoming && upcomingSection.map(t => <TaskRow key={t.id} task={t} />)}
          </>}
          {noDateSection.length > 0 && <>
            <SectionHeader label="No date" icon="—" count={noDateSection.length}
              colour={C.textMuted} pillStyle={{ background:C.bgSecondary, color:C.textMuted, borderColor:C.border }}
              isOpen={sectionOpen.nodate} onToggle={() => toggleSection("nodate")} />
            {sectionOpen.nodate && noDateSection.map(t => <TaskRow key={t.id} task={t} />)}
          </>}
          {completedSection.length > 0 && <>
            <SectionHeader label="Completed" icon="✓" count={completedSection.length}
              colour={C.green} pillStyle={{ background:C.greenLight, color:C.green, borderColor:C.greenBorder }}
              isOpen={sectionOpen.completed} onToggle={() => toggleSection("completed")} />
            {sectionOpen.completed && completedSection.map(t => <TaskRow key={t.id} task={t} />)}
          </>}
          {showArchived && <>
            <SectionHeader label="Archived" icon="🗄" count={archivedTasks.length}
              colour={C.textMuted} pillStyle={{ background:C.bgSecondary, color:C.textMuted, borderColor:C.border }}
              isOpen={sectionOpen.archived} onToggle={() => toggleSection("archived")} />
            {sectionOpen.archived && (archivedTasks.length === 0 ? (
              <div style={{ padding:"14px 14px", fontSize:11, color:C.textDim, fontStyle:"italic" }}>No archived tasks{filterCardId || filterPriority !== "all" || taskSearchLower ? " matching the current filters" : ""}</div>
            ) : (
              archivedTasks.map(t => <TaskRow key={t.id} task={t} />)
            ))}
          </>}
          {allTasks.length === 0 && (
            filterCardId ? (
              <div style={{ padding:24, textAlign:"center" }}>
                <div style={{ fontSize:12, color:C.textMuted, marginBottom:10 }}>
                  No tasks yet for this lead.
                </div>
                <span onClick={() => setFilterCardId(null)} style={{
                  fontSize:11, fontWeight:500, color:C.orangeDark, cursor:"pointer",
                  background:C.orangeLight, border:`0.5px solid ${C.orangeBorder}`,
                  borderRadius:999, padding:"4px 14px"
                }}>Clear filter</span>
              </div>
            ) : (
              <div style={{ padding:24, fontSize:11, color:C.textDim, fontStyle:"italic", textAlign:"center" }}>No tasks yet</div>
            )
          )}
        </div>
      </div>

      <DragHandle onMouseDown={onDragLeft} />

      {/* ── RIGHT PANEL ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        {showAddForm ? (
          <AddTaskForm
            deals={deals}
            newTitle={newTitle} setNewTitle={setNewTitle}
            newDueDate={newDueDate} setNewDueDate={setNewDueDate}
            newPriority={newPriority} setNewPriority={setNewPriority}
            newDescription={newDescription} setNewDescription={setNewDescription}
            newDealId={newDealId} setNewDealId={setNewDealId}
            saving={saving} onSave={saveTask}
            onCancel={() => setShowAddForm(false)}
          />
        ) : selectedTask ? (
          <TaskDetail
            task={selectedTask}
            dealName={selectedTask.card_id ? dealName(selectedTask.card_id) : null}
            state={state}
            dispatch={dispatch}
            onDeleted={() => setSelectedTaskId(null)}
            searchNoteId={searchNav?.selectedId === selectedTask.id ? searchNav.noteId : null}
            searchNoteQuery={searchNav?.selectedId === selectedTask.id ? searchNav.noteQuery : null}
            focusSubtaskId={null}
            onCompleted={() => {
              // Advance to the next task in the same ordered list this task
              // came from, so completing one task flows naturally into the
              // next rather than leaving the panel showing a task that has
              // just disappeared from the visible list.
              const orderedIds = [...overdue, ...todayTasks, ...upcoming, ...noDate].map(t => t.id);
              const idx = orderedIds.indexOf(selectedTaskId);
              const nextId = idx >= 0 ? orderedIds.find((id, i) => i > idx) : null;
              setSelectedTaskId(nextId || null);
            }}
            onNavigate={onNavigate}
          />
        ) : (
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8, color:C.textDim }}>
            <div style={{ fontSize:28, opacity:0.2 }}>✓</div>
            <div style={{ fontSize:12, color:C.textDim }}>Select a task or add a new one</div>
          </div>
        )}
      </div>
    </div>
  );
}

function AddTaskForm({ deals, newTitle, setNewTitle, newDueDate, setNewDueDate, newPriority, setNewPriority, newDescription, setNewDescription, newDealId, setNewDealId, saving, onSave, onCancel }) {
  return (
    <>
      <div style={{ padding:"14px 16px 10px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader }}>
        <div style={{ fontSize:10, color:C.textMuted, textTransform:"uppercase", letterSpacing:"0.05em" }}>New task</div>
        <div style={{ fontSize:13, color:C.textDim, marginTop:4 }}>Fill in the details below</div>
      </div>
      <div style={{ flex:1, padding:"14px 16px", display:"flex", flexDirection:"column", gap:12, overflowY:"auto" }}>
        <input
          placeholder="Task title…"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") onSave(); }}
          style={{ width:"100%", border:"none", borderBottom:`0.5px solid ${C.borderMid}`, padding:"4px 0", fontSize:15, fontWeight:500, fontFamily:"inherit", outline:"none", color:C.text, background:"transparent" }}
        />
        <div style={{ display:"flex", gap:8 }}>
          <select value={newPriority} onChange={e => setNewPriority(e.target.value)}
            style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:999, padding:"4px 12px", fontSize:10, fontFamily:"inherit", color:C.textMuted, background:"white" }}>
            {PRIORITIES.map(p => <option key={p} value={p}>{PRI_WORD[p]}</option>)}
          </select>
          <input type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)}
            style={{ flex:1, border:`0.5px solid ${C.borderMid}`, borderRadius:999, padding:"4px 12px", fontSize:10, fontFamily:"inherit", color:C.textMuted, background:"white", outline:"none" }} />
        </div>
        <textarea
          placeholder="Description (optional)…"
          rows={3}
          value={newDescription}
          onChange={e => setNewDescription(e.target.value)}
          style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:8, padding:"8px 10px", fontSize:11, fontFamily:"inherit", resize:"none", color:C.textMuted, outline:"none" }}
        />
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:10, color:C.textMuted, flexShrink:0 }}>Link to deal</span>
          <select value={newDealId} onChange={e => setNewDealId(e.target.value)}
            style={{ flex:1, border:`0.5px solid ${C.borderMid}`, borderRadius:999, padding:"4px 12px", fontSize:10, fontFamily:"inherit", color:C.textMuted, background:"white" }}>
            <option value="">— None (floating task)</option>
            {deals.filter(d => !d.archived).map(d => (
              <option key={d.id} value={d.id}>{d.deal_name || d.name || d.id}</option>
            ))}
          </select>
        </div>
        {!newDealId && (
          <div style={{ background:C.purpleLight, border:`0.5px solid ${C.purpleBorder}`, borderRadius:8, padding:"6px 10px", fontSize:10, color:"#5b21b6", display:"flex", alignItems:"center", gap:6 }}>
            ▶ This will be saved as a floating task — not linked to any deal
          </div>
        )}
        <div style={{ display:"flex", gap:7, justifyContent:"flex-end" }}>
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn variant="solid" onClick={onSave}>{saving ? "Saving…" : "Save task"}</Btn>
        </div>
      </div>
    </>
  );
}

function TaskDetail({ task, dealName, state, dispatch, onDeleted, onCompleted, onNavigate, searchNoteId, searchNoteQuery, focusSubtaskId }) {
  const { confirmEl, confirm } = useConfirm();
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [actionPanelOpen, setActionPanelOpen] = useState(false); // kept for sync reset in useEffect
  const [editDesc, setEditDesc] = useState(task.description || "");
  const [editTitle, setEditTitle] = useState(task.title || "");
  const [editDue, setEditDue] = useState(task.due_date || "");
  const [editPriority, setEditPriority] = useState(task.priority || "normal");
  const [newSubtask, setNewSubtask] = useState("");
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [newSubtaskDue, setNewSubtaskDue] = useState("");
  const [newSubtaskPriority, setNewSubtaskPriority] = useState("normal");
  const [newSubtaskStandalone, setNewSubtaskStandalone] = useState(false);
  const [showSubtaskInput, setShowSubtaskInput] = useState(false);
  const [editingSubtaskId, setEditingSubtaskId] = useState(null);
  const [editSubtaskText, setEditSubtaskText] = useState("");
  const [editSubtaskTitle, setEditSubtaskTitle] = useState("");
  const [editSubtaskDue, setEditSubtaskDue] = useState("");
  const [editSubtaskPriority, setEditSubtaskPriority] = useState("normal");
  const [editSubtaskStandalone, setEditSubtaskStandalone] = useState(false);
  const [subtaskDateError, setSubtaskDateError] = useState(null); // { subtaskId|null, message }
  const [resolvingSubtaskId, setResolvingSubtaskId] = useState(null);
  const [subtaskResolutionText, setSubtaskResolutionText] = useState("");
  const [saving, setSaving] = useState(false);
  const [showResolutionPrompt, setShowResolutionPrompt] = useState(false);
  const [resolutionText, setResolutionText] = useState("");
  const [closeOpenSubtasks, setCloseOpenSubtasks] = useState(true); // default on: close open subtasks with parent
  const [noteText, setNoteText] = useState("");
  const [noteChannel, setNoteChannel] = useState("Note");
  const [noteTyping, setNoteTyping] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteDriveLink, setNoteDriveLink] = useState("");
  const [noteDriveLinkLabel, setNoteDriveLinkLabel] = useState("");

  // Sync when task changes
  const taskId = task.id;
  useEffect(() => {
    setEditDesc(task.description || "");
    setEditTitle(task.title || "");
    setEditDue(task.due_date || "");
    setEditPriority(task.priority || "normal");
    setEditingTitle(false);
    setEditingDesc(false);
    setActionPanelOpen(false);
    setShowSubtaskInput(false);
    setShowResolutionPrompt(false);
    setResolutionText("");
    setNoteText("");
    setNoteChannel("Note");
    setNoteTyping(false);
    setNewSubtask(""); setNewSubtaskDue(""); setNewSubtaskPriority("normal");
    setEditingSubtaskId(null); setEditSubtaskText(""); setEditSubtaskDue(""); setEditSubtaskPriority("normal");
    setSubtaskDateError(null);
  }, [taskId]);

  // Progress notes — thread entries linked to this task
  const notes = Object.values(state.threads)
    .filter(e => e.card_id === task.id && e.card_type === "task")
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at)); // newest first

  const noteRefs = useRef({});
  const [showMatchBg, setShowMatchBg] = useState(!!searchNoteId);

  // Scroll the matched note into view when arriving here from a search hit.
  useEffect(() => {
    if (!searchNoteId) return;
    setShowMatchBg(true);
    const el = noteRefs.current[searchNoteId];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setShowMatchBg(false), 2600);
    return () => clearTimeout(t);
    // One-shot per search hit: re-fire only when the target note or task changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchNoteId, taskId]);

  // Same mechanism as the note-targeting above, but for a subtask clicked
  // from the main task list (Overdue/Today/Upcoming). Kept as a separate
  // ref map rather than reusing noteRefs so a note id and a subtask id can
  // never collide even though that's already unlikely given both use genId().
  const subtaskRefs = useRef({});
  const [showSubtaskMatchBg, setShowSubtaskMatchBg] = useState(!!focusSubtaskId);
  useEffect(() => {
    if (!focusSubtaskId) return;
    setShowSubtaskMatchBg(true);
    const el = subtaskRefs.current[focusSubtaskId];
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setShowSubtaskMatchBg(false), 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSubtaskId, taskId]);

  const addNote = async () => {
    if (!noteText.trim()) return;
    setNoteSaving(true);
    try {
      const entry = {
        id: genId(), card_id: task.id, card_type: "task",
        channel: noteChannel, text: noteText.trim(),
        is_system_event: false, created_at: nowISO()
      };
      // Attempt to include drive_link fields — silently omit if column doesn't exist
      if (noteDriveLink.trim()) {
        try {
          const testEntry = { ...entry, drive_link: noteDriveLink.trim(), drive_link_label: noteDriveLinkLabel.trim() || null };
          await sb.insert("thread_entries", testEntry);
          dispatch({ type:"ADD_THREAD", entry: testEntry });
        } catch(e2) {
          await sb.insert("thread_entries", entry);
          dispatch({ type:"ADD_THREAD", entry });
        }
        // Echo into the deal's Activity timeline (no-op for floating tasks)
        await logTaskEvent(dispatch, task, "task_doc", { drive_link: noteDriveLink.trim(), drive_link_label: noteDriveLinkLabel.trim() || null });
      } else {
        await sb.insert("thread_entries", entry);
        dispatch({ type:"ADD_THREAD", entry });
      }
      setNoteText("");
      setNoteChannel("Note");
      setNoteTyping(false);
      setNoteDriveLink(""); setNoteDriveLinkLabel("");
    } catch(e) { console.error(e); }
    setNoteSaving(false);
  };

  const deleteNote = async (id) => {
    try {
      await sb.delete("thread_entries", id);
      dispatch({ type:"DELETE_THREAD", id });
    } catch(e) { console.error(e); }
  };

  const overdue = task.status !== "completed" && task.status !== "archived" && isOverdue(task.due_date);
  const done = task.status === "completed";
  const archived = task.status === "archived";

  const statusLabel = () => {
    if (archived) return "Archived";
    if (done) return "Completed";
    if (overdue) return "Overdue task";
    if (isToday(task.due_date)) return "Due today";
    return "Task";
  };

  const saveField = async (field, value) => {
    setSaving(true);
    try {
      const updates = { [field]: value || null };
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const saveEdits = async () => {
    setSaving(true);
    try {
      const updates = { title: editTitle.trim(), description: editDesc.trim(), due_date: editDue || null, priority: editPriority };
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const markComplete = () => {
    // Show resolution prompt instead of saving immediately
    setShowResolutionPrompt(true);
  };

  const confirmComplete = async () => {
    setSaving(true);
    try {
      const updates = { status: "completed", resolution: resolutionText.trim() || null, completed_at: nowISO() };
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
      await logTaskEvent(dispatch, task, "task_completed", { resolution: resolutionText.trim() || null });

      // Close any open subtasks if the user opted to do so (v9.3.62).
      if (closeOpenSubtasks) {
        const openOnes = subtasks.filter(s => !s.done);
        if (openOnes.length > 0) {
          const closedSubtasks = subtasks.map(s =>
            s.done ? s : { ...s, done: true, resolution: "Closed with parent task", completed_at: nowISO() }
          );
          await sb.update("tasks", task.id, { subtasks: closedSubtasks });
          dispatch({ type:"UPDATE_TASK", id:task.id, updates:{ subtasks: closedSubtasks } });
        }
      }

      setShowResolutionPrompt(false);
      if (onCompleted) onCompleted();
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  const reopen = async () => {
    try {
      await sb.update("tasks", task.id, { status: "not_started", resolution: null, completed_at: null });
      dispatch({ type:"UPDATE_TASK", id:task.id, updates:{ status:"not_started", resolution:null, completed_at:null } });
    } catch (e) { console.error(e); }
  };

  const deleteTask = async () => {
    if (!await confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
    try {
      await sb.delete("tasks", task.id);
      dispatch({ type:"DELETE_TASK", id:task.id });
      onDeleted();
    } catch (e) { console.error(e); }
  };

  const archiveTask = async () => {
    try {
      // Store the pre-archive status so restoreTask can return the task
      // to its correct prior state (completed tasks stay completed on
      // restore; open tasks return to not_started). (v9.3.66)
      const updates = { status:"archived", pre_archive_status: task.status };
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
      await logTaskEvent(dispatch, task, "task_archived");
      onDeleted();
    } catch (e) { console.error(e); }
  };

  const restoreTask = async () => {
    try {
      // Restore to the pre-archive status if recorded; fall back to
      // inferring from completed_at (handles tasks archived before v9.3.66).
      // Never restore to "archived" — that would be a no-op.
      const priorStatus = (task.pre_archive_status && task.pre_archive_status !== "archived")
        ? task.pre_archive_status
        : task.completed_at ? "completed" : "not_started";
      const updates = { status: priorStatus, pre_archive_status: null };
      await sb.update("tasks", task.id, updates);
      dispatch({ type:"UPDATE_TASK", id:task.id, updates });
      onDeleted();
    } catch (e) { console.error(e); }
  };

  const permanentlyDeleteTask = async () => {
    if (!await confirm(`Permanently delete "${task.title}"? This cannot be undone — the task and all its notes will be gone for good.`)) return;
    try {
      await sb.delete("tasks", task.id);
      dispatch({ type:"DELETE_TASK", id:task.id });
      onDeleted();
    } catch (e) { console.error(e); }
  };

  const subtasksRaw = Array.isArray(task.subtasks) ? task.subtasks : [];
  // Legacy subtasks (added before this version) have no id — backfill one for
  // stable identity without requiring a migration. Must be done with a
  // useEffect that persists the backfilled ids, not inline on every render:
  // regenerating a random id per render would make editingSubtaskId stop
  // matching the moment the component re-renders.
  const needsIdBackfill = subtasksRaw.some(s => !s.id);
  useEffect(() => {
    if (!needsIdBackfill) return;
    const backfilled = subtasksRaw.map(s => ({
      id: s.id || genId(),
      parent_subtask_id: s.parent_subtask_id !== undefined ? s.parent_subtask_id : null,
      due_date: s.due_date !== undefined ? s.due_date : null,
      ...s,
      id: s.id || genId(),
    }));
    sb.update("tasks", task.id, { subtasks: backfilled })
      .then(() => dispatch({ type:"UPDATE_TASK", id:task.id, updates:{ subtasks: backfilled } }))
      .catch(e => console.error(e));
    // Runs once per task when stable ids are missing; not re-triggered by
    // its own write because needsIdBackfill becomes false once backfilled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, needsIdBackfill]);

  const subtasks = subtasksRaw.map(s => ({
    parent_subtask_id: null,
    due_date: null,
    priority: "normal",
    resolution: null,
    ...s,
    id: s.id || `__pending_${subtasksRaw.indexOf(s)}`,
  }));

  // A subtask's due date may not fall after the parent task's due date.
  // Same day is fine; only strictly-after dates are blocked. Validation is
  // inlined into addSubtask/saveEditSubtask (rather than factored into a
  // shared helper) so each can accept an override parent date — needed
  // because dispatch() doesn't update `task` synchronously, so a "push the
  // parent's date out and retry" flow can't rely on the just-dispatched
  // value being visible yet in this closure.

  const persistSubtasks = async (updated) => {
    await sb.update("tasks", task.id, { subtasks: updated });
    dispatch({ type:"UPDATE_TASK", id:task.id, updates:{ subtasks: updated } });
  };

  const toggleSubtask = async (id) => {
    const target = subtasks.find(s => s.id === id);
    if (!target) return;
    if (!target.done) {
      // Completing — open the inline resolution prompt instead of saving
      // immediately, mirroring the main task's confirmComplete flow.
      setResolvingSubtaskId(id);
      setSubtaskResolutionText("");
      return;
    }
    // Reopening — clear resolution, save immediately (same reasoning as
    // the main task: a reopened item shouldn't silently carry a stale
    // resolution note from before).
    const updated = subtasks.map(s => s.id === id ? { ...s, done: false, resolution: null } : s);
    try { await persistSubtasks(updated); } catch (e) { console.error(e); }
  };

  const confirmCompleteSubtask = async (id) => {
    const updated = subtasks.map(s => s.id === id ? { ...s, done: true, resolution: subtaskResolutionText.trim() || null } : s);
    try {
      await persistSubtasks(updated);
      setResolvingSubtaskId(null);
      setSubtaskResolutionText("");
    } catch (e) { console.error(e); }
  };

  const cancelCompleteSubtask = () => {
    setResolvingSubtaskId(null);
    setSubtaskResolutionText("");
  };

  const deleteSubtask = async (id) => {
    const updated = subtasks.filter(s => s.id !== id);
    try {
      await persistSubtasks(updated);
      // If the deleted subtask was mid-edit or mid-resolution-prompt, clear
      // that state so the form doesn't linger referencing a row that no
      // longer exists.
      if (editingSubtaskId === id) cancelEditSubtask();
      if (resolvingSubtaskId === id) cancelCompleteSubtask();
    } catch (e) { console.error(e); }
  };

  const addSubtask = async (overrideParentDue) => {
    if (!newSubtaskTitle.trim()) return; // title is mandatory
    // Date conflict check only applies to dependent subtasks — an independent
    // task (standalone: true) is not constrained by its parent's due date.
    if (!newSubtaskStandalone) {
      const effectiveParentDue = overrideParentDue !== undefined ? overrideParentDue : task.due_date;
      const conflict = (newSubtaskDue && effectiveParentDue && new Date(newSubtaskDue) > new Date(effectiveParentDue))
        ? `This subtask is due after the task's due date (${fmtDate(effectiveParentDue)}).`
        : null;
      if (conflict) { setSubtaskDateError({ subtaskId: null, message: conflict }); return; }
    }
    const entry = {
      id: genId(), title: newSubtaskTitle.trim(), text: newSubtask.trim(), done: false,
      due_date: newSubtaskDue || null, priority: newSubtaskPriority || "normal",
      standalone: newSubtaskStandalone,
      parent_subtask_id: null,
      created_at: nowISO(), updated_at: nowISO(),
    };
    const updated = [...subtasks, entry];
    try {
      await persistSubtasks(updated);
      setNewSubtaskTitle(""); setNewSubtask(""); setNewSubtaskDue("");
      setNewSubtaskPriority("normal"); setNewSubtaskStandalone(false);
      setShowSubtaskInput(false); setSubtaskDateError(null);
    } catch (e) { console.error(e); }
  };

  const startEditSubtask = (s) => {
    setEditingSubtaskId(s.id);
    setEditSubtaskTitle(s.title || "");
    setEditSubtaskText(s.text);
    setEditSubtaskDue(s.due_date || "");
    setEditSubtaskPriority(s.priority || "normal");
    setEditSubtaskStandalone(s.standalone || false);
    setSubtaskDateError(null);
  };

  const cancelEditSubtask = () => {
    setEditingSubtaskId(null); setEditSubtaskTitle(""); setEditSubtaskText("");
    setEditSubtaskDue(""); setEditSubtaskPriority("normal"); setEditSubtaskStandalone(false);
    setSubtaskDateError(null);
  };

  const saveEditSubtask = async (overrideParentDue) => {
    if (!editSubtaskTitle.trim()) return; // title is mandatory
    if (!editSubtaskStandalone) {
      const effectiveParentDue = overrideParentDue !== undefined ? overrideParentDue : task.due_date;
      const conflict = (editSubtaskDue && effectiveParentDue && new Date(editSubtaskDue) > new Date(effectiveParentDue))
        ? `This subtask is due after the task's due date (${fmtDate(effectiveParentDue)}).`
        : null;
      if (conflict) { setSubtaskDateError({ subtaskId: editingSubtaskId, message: conflict }); return; }
    }
    const updated = subtasks.map(s => s.id === editingSubtaskId
      ? { ...s, title: editSubtaskTitle.trim(), text: editSubtaskText.trim(),
          due_date: editSubtaskDue || null, priority: editSubtaskPriority || "normal",
          standalone: editSubtaskStandalone, updated_at: nowISO() }
      : s);
    try {
      await persistSubtasks(updated);
      cancelEditSubtask();
    } catch (e) { console.error(e); }
  };

  // Resolves a blocked subtask save by pushing the parent task's own due
  // date out to match — the "change the parent instead" escape hatch for
  // the hard block, available inline so resolving it doesn't require
  // leaving the panel. Accepts an optional callback to finish the original
  // add/edit immediately after the parent's date is updated, rather than
  // just clearing the error and leaving the user to click Save again.
  const pushParentDueDateTo = async (newDate, then) => {
    try {
      await sb.update("tasks", task.id, { due_date: newDate });
      dispatch({ type:"UPDATE_TASK", id:task.id, updates:{ due_date: newDate } });
      setEditDue(newDate);
      setSubtaskDateError(null);
      if (then) await then();
    } catch (e) { console.error(e); }
  };

  const priColour = PRI_COLOUR[task.priority] || PRI_COLOUR.normal;

  return (
    <>
      {/* Header — compact, no pills, single metadata line */}
      <div style={{ padding:"12px 14px 0", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader }}>

        {/* Title row — inline editable on click, no edit mode gate */}
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8, marginBottom:4 }}>
          <div style={{ display:"flex", alignItems:"flex-start", gap:8, flex:1, minWidth:0 }}>
            {/* Completion circle */}
            {!editingTitle && (
              <div onClick={() => !done && !archived && markComplete()}
                style={{ width:18, height:18, borderRadius:"50%", flexShrink:0, marginTop:2,
                  border: done ? "none" : `1.5px solid ${done ? "transparent" : C.borderMid}`,
                  background: done ? C.teal : "transparent",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  cursor: done || archived ? "default" : "pointer" }}
                onMouseEnter={e => { if (!done && !archived) e.currentTarget.style.borderColor = C.green; }}
                onMouseLeave={e => { if (!done && !archived) e.currentTarget.style.borderColor = C.borderMid; }}>
                {done && <span style={{ color:"white", fontSize:11 }}>✓</span>}
              </div>
            )}
            <div style={{ flex:1, minWidth:0 }}>
              {/* Title: click to edit inline, save on blur */}
              {editingTitle ? (
                <input autoFocus value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onBlur={() => { setEditingTitle(false); saveField("title", editTitle.trim()); }}
                  onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } if (e.key === "Escape") { setEditTitle(task.title||""); setEditingTitle(false); } }}
                  style={{ width:"100%", fontSize:15, fontWeight:500, color:C.text, border:"none",
                    borderBottom:`0.5px solid ${C.tealBorder}`, outline:"none",
                    fontFamily:"inherit", background:"transparent" }} />
              ) : (
                <div onClick={() => !done && !archived && (setEditTitle(task.title||""), setEditingTitle(true))}
                  style={{ fontSize:15, fontWeight:500, lineHeight:1.3,
                    textDecoration: done ? "line-through" : "none",
                    color: done ? C.textMuted : C.text,
                    cursor: done || archived ? "default" : "text",
                    borderRadius:4, padding:"1px 2px", marginLeft:-2,
                    transition:"background 0.1s" }}
                  onMouseEnter={e => { if (!done && !archived) e.currentTarget.style.background = C.bgSecondary; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
                  {task.title}
                </div>
              )}
              {PRI_STARS[task.priority] > 0 && !editingTitle && (
                <div style={{ fontSize:15, fontWeight:900, color:PRI_STAR_COLOUR[task.priority],
                  lineHeight:1, marginTop:2, letterSpacing:1 }}>
                  {"*".repeat(PRI_STARS[task.priority])}
                </div>
              )}
            </div>
          </div>

          {/* Reopen / Restore for done/archived states — unchanged */}
          {done ? (
            <span onClick={reopen} title="Reopen this task" style={{
              display:"inline-flex", alignItems:"center", gap:5,
              fontSize:10, fontWeight:500, cursor:"pointer", flexShrink:0,
              padding:"4px 10px", borderRadius:6,
              background:C.bgSecondary, color:C.textSecondary, border:`0.5px solid ${C.borderMid}`,
            }}>
              <i className="ti ti-rotate-clockwise" style={{ fontSize:13 }} />Reopen
            </span>
          ) : archived ? (
            <span onClick={restoreTask} title="Restore this task" style={{
              display:"inline-flex", alignItems:"center", gap:5,
              fontSize:10, fontWeight:500, cursor:"pointer", flexShrink:0,
              padding:"4px 10px", borderRadius:6,
              background:C.tealLight, color:C.tealText, border:`0.5px solid ${C.tealBorder}`,
            }}>
              <i className="ti ti-rotate-clockwise" style={{ fontSize:13 }} />Restore
            </span>
          ) : null}
        </div>

        {/* Single compact metadata line — no pills */}
        <div style={{ fontSize:10, color:C.textMuted, marginBottom:10, lineHeight:1.5 }}>
          {(() => {
            // Use the deal's current state to determine board tab, not
            // task.card_type — after promotion card_type stays "lead" but
            // the deal is now potential/active. (v9.3.69)
            const linkedDeal = task.card_id ? state.deals[task.card_id] : null;
            const isLead = linkedDeal ? linkedDeal.state === "lead" : task.card_type === "lead";
            if (isLead) return (
              <span onClick={() => onNavigate && onNavigate({ view:"board", dealId:task.card_id, boardTab:"lead" })}
                style={{ cursor: onNavigate ? "pointer" : "default", color: onNavigate ? C.orangeDark : C.textMuted,
                  display:"inline-flex", alignItems:"center", gap:3 }}>
                <i className="ti ti-link" aria-hidden="true" style={{ fontSize:11 }} />
                Lead · {dealName}
              </span>
            );
            if (dealName) return (
              <span onClick={() => onNavigate && onNavigate({ view:"board", dealId:task.card_id })}
                style={{ cursor: onNavigate ? "pointer" : "default", color: onNavigate ? C.tealText : C.textMuted,
                  display:"inline-flex", alignItems:"center", gap:3 }}>
                <i className="ti ti-link" aria-hidden="true" style={{ fontSize:11 }} />
                {dealName}
              </span>
            );
            return <span style={{ color:C.textDim }}>Floating</span>;
          })()}
          {task.due_date && (
            <span style={{ color: overdue ? C.red : isToday(task.due_date) ? C.green : C.textMuted }}>
              {" · "}
              {isToday(task.due_date) ? "Today" : overdue ? `${fmtDate(task.due_date)} · overdue` : fmtDate(task.due_date)}
            </span>
          )}
        </div>

        {/* Action row — always visible for open tasks.
            Priority + Date always accessible. Complete | Archive | Delete.
            Archive and Delete have confirmation prompts. */}
        {!archived && !done && (
          <div style={{ display:"flex", alignItems:"center", gap:5, paddingBottom:10, flexWrap:"wrap" }}>
            {/* Priority selector — asterisk labels matching list convention */}
            {PRIORITIES.map(p => (
              <span key={p} onClick={() => { setEditPriority(p); saveField("priority", p); }}
                title={PRI_LABEL[p]} style={{
                  padding:"3px 7px", borderRadius:6, cursor:"pointer",
                  fontSize:11, fontWeight:700,
                  border:`1px solid ${editPriority===p ? (PRI_STAR_COLOUR[p]||C.borderMid) : C.border}`,
                  background: editPriority===p ? (p==="low" ? C.bgSecondary : PRI_DOT[p]?.bg||C.bgSecondary) : "transparent",
                  color: editPriority===p ? (PRI_STAR_COLOUR[p]||C.textMuted) : C.textMuted,
                  transition:"all 0.1s",
                }}>
                {PRI_STARS[p] > 0 ? "*".repeat(PRI_STARS[p]) : "–"}
              </span>
            ))}
            <div style={{ width:"0.5px", height:16, background:C.borderMid, margin:"0 2px" }} />
            {/* Date input — always visible, saves on change */}
            <input type="date" value={editDue}
              onChange={e => { setEditDue(e.target.value); saveField("due_date", e.target.value); }}
              style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6,
                padding:"3px 6px", fontSize:10, fontFamily:"inherit",
                outline:"none", color: editDue ? C.text : C.textDim,
                background:"transparent", cursor:"pointer" }} />
            <div style={{ width:"0.5px", height:16, background:C.borderMid, margin:"0 2px" }} />
            {/* Complete */}
            <span onClick={markComplete} title="Mark complete" style={{
              width:28, height:28, borderRadius:7, border:`0.5px solid ${C.greenBorder}`,
              background:C.greenLight, display:"inline-flex", alignItems:"center",
              justifyContent:"center", cursor:"pointer", color:C.green, fontSize:15,
            }}>
              <i className="ti ti-check" aria-hidden="true" />
            </span>
            {/* Archive — with confirmation */}
            <span onClick={async () => {
              if (!await confirm(`Archive "${task.title}"?`)) return;
              await archiveTask();
            }} title="Archive" style={{
              width:28, height:28, borderRadius:7, border:`0.5px solid ${C.borderMid}`,
              background:"transparent", display:"inline-flex", alignItems:"center",
              justifyContent:"center", cursor:"pointer", color:C.textMuted, fontSize:15,
            }}>
              <i className="ti ti-archive" aria-hidden="true" />
            </span>
            <div style={{ width:"0.5px", height:16, background:C.borderMid, margin:"0 2px" }} />
            {/* Delete — already has confirmation inside deleteTask */}
            <span onClick={deleteTask} title="Delete" style={{
              width:28, height:28, borderRadius:7, border:`0.5px solid ${C.redBorder}`,
              background:C.redLight, display:"inline-flex", alignItems:"center",
              justifyContent:"center", cursor:"pointer", color:C.red, fontSize:15,
            }}>
              <i className="ti ti-trash" aria-hidden="true" />
            </span>
          </div>
        )}

        {/* Archived state action row */}
        {archived && (
          <div style={{ display:"flex", alignItems:"center", gap:6, paddingBottom:10 }}>
            <span onClick={permanentlyDeleteTask} title="Delete permanently" aria-label="Delete permanently" style={{
              width:30, height:30, borderRadius:7, border:`0.5px solid ${C.redBorder}`,
              background:C.redLight, display:"inline-flex", alignItems:"center",
              justifyContent:"center", cursor:"pointer", color:C.red, fontSize:15,
            }}>
              <i className="ti ti-trash" aria-hidden="true" />
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:14 }}>
        {/* Description — click to edit inline, save on blur */}
        <div>
          <SectionLabel>Description</SectionLabel>
          {editingDesc ? (
            <textarea autoFocus dir="ltr" value={editDesc}
              onChange={e => {
                setEditDesc(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onBlur={() => { setEditingDesc(false); saveField("description", editDesc.trim()); }}
              onKeyDown={e => { if (e.key === "Escape") { setEditDesc(task.description||""); setEditingDesc(false); } }}
              ref={el => { if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; } }}
              style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:8, padding:"8px 10px",
                fontSize:12, fontFamily:"inherit", resize:"none", color:C.text, outline:"none",
                lineHeight:1.6, overflowY:"hidden", minHeight:80, whiteSpace:"pre-wrap" }} />
          ) : (
            <div onClick={() => !done && !archived && (setEditDesc(task.description||""), setEditingDesc(true))}
              style={{ fontSize:12, color: task.description ? C.text : C.textDim, lineHeight:1.6,
                fontStyle: task.description ? "normal" : "italic",
                whiteSpace:"pre-wrap", wordBreak:"break-word",
                cursor: done || archived ? "default" : "text",
                borderRadius:6, padding:"4px 6px", marginLeft:-6,
                transition:"background 0.1s" }}
              onMouseEnter={e => { if (!done && !archived) e.currentTarget.style.background = C.bgSecondary; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}>
              {task.description || (done || archived ? "No description" : "Click to add description…")}
            </div>
          )}
        </div>

        {/* Chase note is rendered as a synthetic thread entry in the
            Progress notes timeline below (v9.3.50) — no longer a
            standalone box. See DESIGN_DECISIONS §17 for rationale. */}

        {/* Resolution prompt — shown inline when marking complete */}
        {showResolutionPrompt && (() => {
          const openSubtaskCount = subtasks.filter(s => !s.done).length;
          return (
            <div style={{ background:C.greenLight, border:`0.5px solid ${C.greenBorder}`, borderRadius:8, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8 }}>
              <div style={{ fontSize:11, fontWeight:500, color:C.green }}>How was this resolved? <span style={{ fontWeight:400, color:C.textMuted }}>(optional)</span></div>
              <textarea
                autoFocus
                value={resolutionText}
                onChange={e => setResolutionText(e.target.value)}
                placeholder="e.g. Called Yonah, agreed to proceed — needs updated KYC by end of week"
                rows={3}
                style={{ width:"100%", border:`0.5px solid ${C.greenBorder}`, borderRadius:6, padding:"7px 9px", fontSize:11, fontFamily:"inherit", resize:"none", color:C.text, outline:"none", lineHeight:1.5 }}
              />
              {/* Open subtask warning + close-all option (v9.3.62) */}
              {openSubtaskCount > 0 && (
                <div style={{ background:"white", border:`0.5px solid ${C.orangeBorder}`, borderRadius:6, padding:"8px 10px", display:"flex", flexDirection:"column", gap:6 }}>
                  <div style={{ fontSize:10, color:C.orangeDark, fontWeight:500 }}>
                    ⚠ This task has {openSubtaskCount} open subtask{openSubtaskCount > 1 ? "s" : ""}.
                  </div>
                  <label style={{ display:"flex", alignItems:"center", gap:7, cursor:"pointer", fontSize:10, color:C.textSecondary, userSelect:"none" }}>
                    <input type="checkbox" checked={closeOpenSubtasks}
                      onChange={e => setCloseOpenSubtasks(e.target.checked)}
                      style={{ cursor:"pointer", accentColor:C.green }} />
                    Close {openSubtaskCount > 1 ? "all open subtasks" : "this subtask"} with the parent task
                  </label>
                  {!closeOpenSubtasks && (
                    <div style={{ fontSize:10, color:C.textMuted, fontStyle:"italic" }}>
                      Open subtasks will remain unresolved after completion.
                    </div>
                  )}
                </div>
              )}
              <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
                <Btn onClick={() => { setShowResolutionPrompt(false); setResolutionText(""); setCloseOpenSubtasks(true); }}>Cancel</Btn>
                <Btn style={{ background:C.green, color:"#fff", borderColor:C.green, padding:"5px 14px" }} onClick={confirmComplete}>
                  {saving ? "Saving…" : "Mark complete"}
                </Btn>
              </div>
            </div>
          );
        })()}

        {/* Resolution — shown on completed tasks */}
        {done && task.resolution && (
          <>
            <Divider />
            <div>
              <SectionLabel>Resolution</SectionLabel>
              <div style={{ fontSize:12, color:C.text, lineHeight:1.6, whiteSpace:"pre-wrap", wordBreak:"break-word", background:C.greenLight, border:`0.5px solid ${C.greenBorder}`, borderRadius:6, padding:"8px 10px" }}>
                {task.resolution}
              </div>
              {task.completed_at && (
                <div style={{ fontSize:10, color:C.textDim, marginTop:5 }}>✓ Completed {fmtDate(task.completed_at)} at {new Date(task.completed_at).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}</div>
              )}
            </div>
          </>
        )}
        {done && !task.resolution && task.completed_at && (
          <>
            <Divider />
            <div style={{ fontSize:10, color:C.textDim }}>✓ Completed {fmtDate(task.completed_at)} at {new Date(task.completed_at).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}</div>
          </>
        )}

        {/* Progress notes */}
        <Divider />
        <div>
          <SectionLabel>Progress notes</SectionLabel>

          {/* Build the merged timeline: chase note (if present) rendered
              as a synthetic entry alongside real thread notes, sorted
              chronologically. Chase note uses task.created_at as its
              timestamp since it's set at task creation. This is render-
              only — tasks.chase_note is not migrated to thread_entries
              in v9. See DESIGN_DECISIONS §17 for the v10 migration plan. */}
          {(() => {
            const chaseEntry = task.chase_note ? [{
              id: `__chase_${task.id}`,
              kind: "chase",
              text: task.chase_note,
              created_at: task.created_at,
              is_synthetic: true,
            }] : [];
            const allEntries = [...notes, ...chaseEntry]
              .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            if (allEntries.length === 0) return null;
            return (
              <div style={{ display:"flex", flexDirection:"column", gap:0, marginBottom:10 }}>
                {allEntries.map((entry, idx) => {
                  const isLast = idx === allEntries.length - 1;
                  const isChase = entry.kind === "chase";
                  const isMatch = entry.id === searchNoteId;
                  const dotColour = isChase ? C.orangeDark : C.tealBorder;
                  return (
                    <div key={entry.id} ref={el => { if (el && !isChase) noteRefs.current[entry.id] = el; }}
                      style={{ display:"flex", gap:0 }}>
                      {/* Timeline column */}
                      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", width:28, flexShrink:0 }}>
                        {isChase ? (
                          <div style={{ width:8, height:8, borderRadius:"50%", background:dotColour, flexShrink:0, marginTop:4, zIndex:1 }} />
                        ) : entry.channel && CH_ICON[entry.channel] ? (
                          <div style={{ width:18, height:18, borderRadius:"50%", flexShrink:0, marginTop:1, zIndex:1,
                            background: CH_COLOUR[entry.channel]?.bg || C.bgSecondary,
                            border: `1px solid ${CH_COLOUR[entry.channel]?.border || C.borderMid}`,
                            display:"flex", alignItems:"center", justifyContent:"center" }}>
                            <i className={`ti ${CH_ICON[entry.channel]}`} style={{ fontSize:10, color: CH_COLOUR[entry.channel]?.text || C.textDim }} />
                          </div>
                        ) : (
                          <div style={{ width:8, height:8, borderRadius:"50%", background:C.tealBorder, flexShrink:0, marginTop:4, zIndex:1 }} />
                        )}
                        {!isLast && <div style={{ width:2, flex:1, minHeight:12, background:C.borderLight, marginTop:2 }} />}
                      </div>
                      {/* Entry content */}
                      <div style={{ flex:1, paddingBottom: isLast ? 0 : 12, paddingLeft:8,
                          marginLeft: isMatch && showMatchBg ? -6 : 0,
                          paddingRight: isMatch && showMatchBg ? 6 : 0,
                          borderRadius: isMatch && showMatchBg ? 5 : 0,
                          background: isMatch && showMatchBg ? "#fef3c7" : "transparent",
                          transition:"background 0.4s" }}
                        onMouseEnter={e => !isChase && e.currentTarget.querySelector(".del-note")?.style && (e.currentTarget.querySelector(".del-note").style.opacity = 1)}
                        onMouseLeave={e => !isChase && e.currentTarget.querySelector(".del-note")?.style && (e.currentTarget.querySelector(".del-note").style.opacity = 0)}>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:2 }}>
                          <span style={{ fontSize:9, color: isChase ? C.orangeDark : C.textDim, fontWeight: isChase ? 500 : 400, textTransform: isChase ? "uppercase" : "none", letterSpacing: isChase ? "0.05em" : 0 }}>
                            {isChase ? "Chase · " : ""}{fmtDate(entry.created_at)} · {fmtTime(entry.created_at)}
                          </span>
                          {!isChase && (
                            <span className="del-note" onClick={() => deleteNote(entry.id)}
                              style={{ fontSize:10, color:C.red, cursor:"pointer", opacity:0, transition:"opacity 0.15s" }}>🗑</span>
                          )}
                        </div>
                        <div style={{ fontSize:11, color: isChase ? C.orangeDark : C.text, lineHeight:1.6,
                          whiteSpace:"pre-wrap", wordBreak:"break-word",
                          background: isChase ? C.orangeLight : "transparent",
                          borderLeft: isChase ? `2px solid ${C.orangeBorder}` : "none",
                          padding: isChase ? "4px 8px" : 0,
                          borderRadius: isChase ? "0 4px 4px 0" : 0 }}>
                          {isChase
                            ? entry.text
                            : <HighlightedText text={entry.text} words={isMatch && searchNoteQuery ? [searchNoteQuery] : null} />
                          }
                        </div>
                        {!isChase && entry.drive_link && (
                          <a href={entry.drive_link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                            style={{ fontSize:9, color:C.blue, textDecoration:"none", cursor:"pointer", display:"inline-flex", alignItems:"center", gap:3, marginTop:3,
                              background:C.blueLight, border:`1px solid ${C.blueBorder}`, borderRadius:999, padding:"2px 8px", fontWeight:500 }}>
                            🔗 {entry.drive_link_label || "Linked document"} ↗
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* Add note input — channel selector appears once user starts typing */}
          {!done && (
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <textarea
                dir="ltr"
                value={noteText}
                onChange={e => { setNoteText(e.target.value); if (e.target.value.length > 0 && !noteTyping) setNoteTyping(true); if (e.target.value.length === 0) { setNoteTyping(false); setNoteChannel("Note"); } }}
                placeholder="Add a progress note… e.g. Chased today, waiting on response"
                rows={2}
                onKeyDown={e => { if (e.key === "Enter" && e.metaKey) addNote(); }}
                style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:7,
                  padding:"7px 9px", fontSize:11, fontFamily:"system-ui,sans-serif",
                  resize:"none", outline:"none", color:C.text, lineHeight:1.5,
                  direction:"ltr", textAlign:"left", writingMode:"horizontal-tb" }}
              />
              {/* Channel type selector — visible only while typing */}
              <div style={{
                display:"flex", alignItems:"center", gap:6,
                maxHeight: noteTyping ? 32 : 0,
                opacity: noteTyping ? 1 : 0,
                overflow:"hidden",
                transition:"max-height 0.18s ease, opacity 0.15s ease"
              }}>
                <span style={{ fontSize:9, color:C.textDim, flexShrink:0 }}>Type:</span>
                {CHANNELS.map(ch => {
                  const col = CH_COLOUR[ch];
                  const isActive = noteChannel === ch;
                  return (
                    <span key={ch} onClick={() => setNoteChannel(ch)} style={{
                      display:"inline-flex", alignItems:"center", justifyContent:"center",
                      width:24, height:24, borderRadius:"50%",
                      background: isActive ? col.border : col.bg,
                      border: `1px solid ${isActive ? col.text : col.border}`,
                      cursor:"pointer", transition:"background 0.12s, border 0.12s",
                      flexShrink:0,
                      boxShadow: isActive ? `0 0 0 2px ${col.border}` : "none"
                    }} title={ch}>
                      <i className={`ti ${CH_ICON[ch]}`} style={{ fontSize:11, color: isActive ? col.text : col.text, opacity: isActive ? 1 : 0.55 }} />
                    </span>
                  );
                })}
              </div>
              {/* Attach document — reveal on type (v9.3.96) */}
              <div style={{
                maxHeight: noteTyping ? 90 : 0, opacity: noteTyping ? 1 : 0,
                overflow:"hidden", transition:"max-height 0.18s ease, opacity 0.15s ease"
              }}>
                <div style={{ background:C.bgSecondary, border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"6px 8px" }}>
                  <div style={{ fontSize:9, color:C.textMuted, marginBottom:4, fontWeight:500 }}>📎 Attach document (optional)</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <input placeholder="Label e.g. Certificate of Analysis" value={noteDriveLinkLabel} onChange={e => setNoteDriveLinkLabel(e.target.value)}
                      style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:5, padding:"3px 7px", fontSize:10, fontFamily:"inherit", outline:"none", color:C.text }} />
                    <input placeholder="https://docs.google.com/… (URL)" value={noteDriveLink} onChange={e => setNoteDriveLink(e.target.value)}
                      style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:5, padding:"3px 7px", fontSize:10, fontFamily:"inherit", outline:"none", color:C.text }} />
                  </div>
                </div>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontSize:9, color:C.textDim }}>⌘ + Enter to save</span>
                <Btn variant="teal" onClick={addNote} style={{ fontSize:10, padding:"4px 12px" }}>
                  {noteSaving ? "Saving…" : "Add note"}
                </Btn>
              </div>
            </div>
          )}
          {done && notes.length === 0 && !task.chase_note && (
            <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No progress notes</div>
          )}
        </div>

        {/* Subtasks */}
        <div>
          <Divider />
          <SectionLabel>Subtasks</SectionLabel>
          {subtasks.length > 0 && (
            <div style={{ display:"flex", flexDirection:"column", gap:0, marginBottom:10 }}>
              {subtasks.map((s, i) => {
                const isEditing = editingSubtaskId === s.id;
                const isResolving = resolvingSubtaskId === s.id;
                const rowError = subtaskDateError && subtaskDateError.subtaskId === s.id ? subtaskDateError : null;
                const isFocusMatch = s.id === focusSubtaskId && showSubtaskMatchBg;
                const isLast = i === subtasks.length - 1;
                return (
                  <div key={s.id} ref={el => { if (el) subtaskRefs.current[s.id] = el; }} style={{ display:"flex", gap:0 }}>
                    {/* Timeline column — same dot+line pattern as Progress notes above, except
                        the dot itself is the done-toggle rather than purely decorative, and its
                        border colour reflects priority so urgent subtasks stand out even
                        collapsed — not just when you open edit mode to check. */}
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", width:28, flexShrink:0 }}>
                      <div onClick={() => toggleSubtask(s.id)} style={{ width:14, height:14, borderRadius:"50%", flexShrink:0, marginTop:4, zIndex:1, cursor:"pointer",
                        background: s.done ? C.teal : "transparent",
                        border: s.done ? "none" : `1.5px solid ${C.borderMid}`,
                        display:"flex", alignItems:"center", justifyContent:"center" }}>
                        {s.done && <span style={{ color:"white", fontSize:8 }}>✓</span>}
                      </div>
                      {!isLast && <div style={{ width:2, flex:1, minHeight:12, background:C.borderLight, marginTop:2 }} />}
                    </div>

                    {/* Subtask content */}
                    <div style={{ flex:1, paddingBottom: isLast ? 0 : 12, paddingLeft:8,
                        marginLeft: isFocusMatch ? -6 : 0, paddingRight: isFocusMatch ? 6 : 0,
                        borderRadius: isFocusMatch ? 5 : 0,
                        background: isFocusMatch ? "#fef3c7" : "transparent",
                        transition:"background 0.4s" }}
                      onMouseEnter={e => e.currentTarget.querySelector(".del-subtask")?.style && (e.currentTarget.querySelector(".del-subtask").style.opacity = 1)}
                      onMouseLeave={e => e.currentTarget.querySelector(".del-subtask")?.style && (e.currentTarget.querySelector(".del-subtask").style.opacity = 0)}>

                      {isResolving ? (
                        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                          {/* Subtask title shown in muted grey so you know what
                              you're closing while writing the resolution note */}
                          <div style={{ fontSize:11, color:C.textMuted, lineHeight:1.4,
                            borderLeft:`2px solid ${C.borderMid}`, paddingLeft:8,
                            fontStyle:"italic" }}>
                            {s.title || s.text}
                          </div>
                          <div style={{ fontSize:10, fontWeight:500, color:C.green }}>
                            How was this resolved? <span style={{ fontWeight:400, color:C.textMuted }}>(optional)</span>
                          </div>
                          <textarea autoFocus value={subtaskResolutionText} onChange={e => setSubtaskResolutionText(e.target.value)}
                            placeholder="e.g. Quintus confirmed no interest at this price"
                            rows={2}
                            style={{ width:"100%", border:`0.5px solid ${C.greenBorder}`, borderRadius:6, padding:"6px 8px", fontSize:11, fontFamily:"inherit", resize:"none", color:C.text, outline:"none", lineHeight:1.5 }} />
                          <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
                            <Btn onClick={() => cancelCompleteSubtask()} style={{ fontSize:10, padding:"3px 9px" }}>Cancel</Btn>
                            <Btn style={{ background:C.green, color:"#fff", borderColor:C.green, fontSize:10, padding:"3px 9px" }}
                              onClick={() => confirmCompleteSubtask(s.id)}>Mark complete</Btn>
                          </div>
                        </div>
                      ) : isEditing ? (
                        <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                          <input autoFocus value={editSubtaskTitle} onChange={e => setEditSubtaskTitle(e.target.value)}
                            placeholder="Subtask title (required)…"
                            onKeyDown={e => { if (e.key === "Enter") saveEditSubtask(); if (e.key === "Escape") cancelEditSubtask(); }}
                            style={{ width:"100%", border:`0.5px solid ${editSubtaskTitle.trim() ? C.borderMid : C.orange}`, borderRadius:6, padding:"4px 7px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
                          <input value={editSubtaskText} onChange={e => setEditSubtaskText(e.target.value)}
                            placeholder="Description (optional)…"
                            style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
                          <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                            <input type="date" value={editSubtaskDue} onChange={e => setEditSubtaskDue(e.target.value)}
                              style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"3px 6px", fontSize:10, fontFamily:"inherit", outline:"none", color:C.text }} />
                            <div style={{ display:"flex", gap:3 }}>
                              {PRIORITIES.map(p => (
                                <span key={p} onClick={() => setEditSubtaskPriority(p)} title={PRI_LABEL[p]} style={{
                                  padding:"2px 7px", borderRadius:6, cursor:"pointer", fontSize:11, fontWeight:700,
                                  border:`1px solid ${editSubtaskPriority===p ? (PRI_STAR_COLOUR[p] || C.borderMid) : C.border}`,
                                  background: editSubtaskPriority===p ? (p === "low" ? C.bgSecondary : PRI_DOT[p].bg) : "transparent",
                                  color: editSubtaskPriority===p ? (PRI_STAR_COLOUR[p] || C.textMuted) : C.textMuted,
                                }}>
                                  {PRI_STARS[p] > 0 ? "*".repeat(PRI_STARS[p]) : "–"}
                                </span>
                              ))}
                            </div>
                            <Btn variant="solid" onClick={() => saveEditSubtask()} style={{ fontSize:10, padding:"3px 9px" }}>Save</Btn>
                            <Btn onClick={() => cancelEditSubtask()} style={{ fontSize:10, padding:"3px 9px" }}>Cancel</Btn>
                            <span onClick={() => setEditSubtaskStandalone(v => !v)}
                              style={{ fontSize:10, cursor:"pointer",
                                color: editSubtaskStandalone ? C.tealText : C.textMuted,
                                background: editSubtaskStandalone ? C.tealLight : "transparent",
                                border:`0.5px solid ${editSubtaskStandalone ? C.tealBorder : C.borderMid}`,
                                borderRadius:4, padding:"3px 7px", userSelect:"none" }}>
                              {editSubtaskStandalone ? "✓ Independent" : "Independent"}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 }}>
                          <div onClick={() => startEditSubtask(s)} style={{ cursor:"pointer", display:"flex", flexDirection:"column", gap:2, flex:1, minWidth:0 }}>
                            <span style={{ fontSize:11, fontWeight:500, color: s.done ? C.textMuted : C.text,
                              textDecoration: s.done ? "line-through" : "none" }}>
                              {s.title || s.text}
                            </span>
                            {s.title && s.text && (
                              <span style={{ fontSize:10, color:C.textMuted, lineHeight:1.4 }}>{s.text}</span>
                            )}
                            <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                              {s.priority && PRI_STARS[s.priority] > 0 && (
                                <span style={{ fontSize:13, fontWeight:900, color: PRI_STAR_COLOUR[s.priority], lineHeight:1 }}>
                                  {"*".repeat(PRI_STARS[s.priority])}
                                </span>
                              )}
                              {s.due_date && (
                                <span style={{ fontSize:9, color: isOverdue(s.due_date) && !s.done ? C.red : C.textDim }}>
                                  {isOverdue(s.due_date) && !s.done ? "⚠ " : ""}{fmtDate(s.due_date)}
                                </span>
                              )}
                            </div>
                            {s.done && s.resolution && (
                              <div style={{ fontSize:10, color:C.textDim, marginTop:2, lineHeight:1.4 }}>{s.resolution}</div>
                            )}
                          </div>
                          <span className="del-subtask" onClick={() => deleteSubtask(s.id)}
                            style={{ fontSize:10, color:C.red, cursor:"pointer", opacity:0, transition:"opacity 0.15s", flexShrink:0, marginTop:1 }}>🗑</span>
                        </div>
                      )}

                      {/* Date conflict warning: subtask is due after the parent's date.
                          Doesn't force a specific value — the subtask's own date field
                          (above) stays freely editable, and the parent's date can be
                          adjusted right here. The button itself reflects whether the
                          currently-shown dates would actually resolve anything — if
                          neither field has changed since the conflict fired, clicking
                          it would just re-fail identically with no visible difference,
                          which read as "frozen" rather than "rejected again". Disabling
                          it until something's actually changed makes that distinction
                          visible instead of silent. */}
                      {rowError && (
                        <div style={{ marginTop:8, background:C.redLight, border:`0.5px solid ${C.redBorder}`, borderRadius:6, padding:"7px 9px" }}>
                          <div style={{ fontSize:10, color:C.red, marginBottom:6 }}>⚠ {rowError.message}</div>
                          <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                            <span style={{ fontSize:9, color:C.textDim }}>Task due date:</span>
                            <input type="date" value={editDue} onChange={e => setEditDue(e.target.value)}
                              style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"3px 6px", fontSize:10, fontFamily:"inherit", outline:"none", color:C.text }} />
                            {(() => {
                              const stillConflicts = editSubtaskDue && editDue && new Date(editSubtaskDue) > new Date(editDue);
                              return (
                                <Btn variant="solid"
                                  onClick={() => { if (!stillConflicts) pushParentDueDateTo(editDue, () => saveEditSubtask(editDue)); }}
                                  style={{ fontSize:9, padding:"3px 8px", opacity: stillConflicts ? 0.45 : 1, cursor: stillConflicts ? "not-allowed" : "pointer" }}>
                                  {stillConflicts ? "Change a date above first" : "Retry with these dates"}
                                </Btn>
                              );
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {showSubtaskInput ? (
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <input autoFocus value={newSubtaskTitle} onChange={e => setNewSubtaskTitle(e.target.value)}
                placeholder="Subtask title (required)…"
                onKeyDown={e => { if (e.key === "Enter") addSubtask(); if (e.key === "Escape") { setShowSubtaskInput(false); setNewSubtaskTitle(""); setNewSubtask(""); setNewSubtaskDue(""); setNewSubtaskPriority("normal"); setSubtaskDateError(null); } }}
                style={{ width:"100%", border:`0.5px solid ${newSubtaskTitle.trim() ? C.borderMid : C.orange}`, borderRadius:6, padding:"5px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
              <input value={newSubtask} onChange={e => setNewSubtask(e.target.value)}
                placeholder="Description (optional)…"
                style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
              <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                <input type="date" value={newSubtaskDue} onChange={e => setNewSubtaskDue(e.target.value)}
                  style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 6px", fontSize:10, fontFamily:"inherit", outline:"none", color:C.text }} />
                <div style={{ display:"flex", gap:3 }}>
                  {PRIORITIES.map(p => (
                    <span key={p} onClick={() => setNewSubtaskPriority(p)} title={PRI_LABEL[p]} style={{
                      padding:"2px 7px", borderRadius:6, cursor:"pointer", fontSize:11, fontWeight:700,
                      border:`1px solid ${newSubtaskPriority===p ? (PRI_STAR_COLOUR[p] || C.borderMid) : C.border}`,
                      background: newSubtaskPriority===p ? (p === "low" ? C.bgSecondary : PRI_DOT[p].bg) : "transparent",
                      color: newSubtaskPriority===p ? (PRI_STAR_COLOUR[p] || C.textMuted) : C.textMuted,
                    }}>
                      {PRI_STARS[p] > 0 ? "*".repeat(PRI_STARS[p]) : "–"}
                    </span>
                  ))}
                </div>
                <Btn variant="solid" onClick={() => addSubtask()} style={{ fontSize:10, padding:"4px 10px", opacity: newSubtaskTitle.trim() ? 1 : 0.45 }}>Add</Btn>
                <Btn onClick={() => { setShowSubtaskInput(false); setNewSubtaskTitle(""); setNewSubtask(""); setNewSubtaskDue(""); setNewSubtaskPriority("normal"); setNewSubtaskStandalone(false); setSubtaskDateError(null); }} style={{ fontSize:10, padding:"4px 10px" }}>✕</Btn>
                {/* Independent task toggle */}
                <span onClick={() => setNewSubtaskStandalone(v => !v)}
                  style={{ fontSize:10, cursor:"pointer", color: newSubtaskStandalone ? C.tealText : C.textMuted,
                    background: newSubtaskStandalone ? C.tealLight : "transparent",
                    border:`0.5px solid ${newSubtaskStandalone ? C.tealBorder : C.borderMid}`,
                    borderRadius:4, padding:"3px 7px", userSelect:"none" }}
                  title="Independent task — floats to its own date in the list rather than grouping under the parent">
                  {newSubtaskStandalone ? "✓ Independent" : "Independent"}
                </span>
              </div>
              {subtaskDateError && subtaskDateError.subtaskId === null && (
                <div style={{ background:C.redLight, border:`0.5px solid ${C.redBorder}`, borderRadius:6, padding:"7px 9px" }}>
                  <div style={{ fontSize:10, color:C.red, marginBottom:6 }}>⚠ {subtaskDateError.message}</div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                    <span style={{ fontSize:9, color:C.textDim }}>Task due date:</span>
                    <input type="date" value={editDue} onChange={e => setEditDue(e.target.value)}
                      style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"3px 6px", fontSize:10, fontFamily:"inherit", outline:"none", color:C.text }} />
                    {(() => {
                      const stillConflicts = newSubtaskDue && editDue && new Date(newSubtaskDue) > new Date(editDue);
                      return (
                        <Btn variant="solid"
                          onClick={() => { if (!stillConflicts) pushParentDueDateTo(editDue, () => addSubtask(editDue)); }}
                          style={{ fontSize:9, padding:"3px 8px", opacity: stillConflicts ? 0.45 : 1, cursor: stillConflicts ? "not-allowed" : "pointer" }}>
                          {stillConflicts ? "Change a date above first" : "Retry with these dates"}
                        </Btn>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <span onClick={() => setShowSubtaskInput(true)} style={{ fontSize:10, color:C.teal, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:4 }}>+ Add subtask</span>
          )}
        </div>
      </div>
      {confirmEl}
    </>
  );
}

// ── SELLER REGISTRY ──
const SELLER_STATUSES = ["active","potential","inactive"];
const SELLER_STATUS_LABEL = { active:"Active", potential:"Potential", inactive:"Inactive" };
const SELLER_STATUS_COLOUR = {
  active:   { bg:C.tealLight,    text:C.tealText,   border:C.tealBorder },
  potential:{ bg:C.amberLight,   text:C.amber,      border:C.amberBorder },
  inactive: { bg:C.bgSecondary,  text:C.textMuted,  border:C.border },
};
const DESTINATIONS = ["Rotterdam","Dubai","Hong Kong","Singapore","Shanghai","Mumbai","London","New York","Zurich","Other"];

function StarRating({ value=0, onChange }) {
  return (
    <div style={{ display:"flex", gap:2 }}>
      {[1,2,3].map(n => (
        <span key={n} onClick={() => onChange && onChange(value === n ? 0 : n)}
          style={{ fontSize:14, cursor: onChange ? "pointer" : "default",
            color: n <= value ? "#f59e0b" : C.borderMid, userSelect:"none" }}>★</span>
      ))}
    </div>
  );
}

function SellerStatusPill({ status }) {
  const s = SELLER_STATUS_COLOUR[status] || SELLER_STATUS_COLOUR.inactive;
  return <Pill style={{ background:s.bg, color:s.text, borderColor:s.border, fontSize:10 }}>{SELLER_STATUS_LABEL[status]||status}</Pill>;
}

function PillToggleGroup({ label, allOptions, selected=[], onChange, pillStyle }) {
  const [editing, setEditing] = useState(false);
  const set = new Set(selected);
  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
        <SectionLabel>{label}</SectionLabel>
        <span onClick={() => setEditing(e => !e)}
          style={{ fontSize:10, color:C.teal, cursor:"pointer", textDecoration:"underline" }}>
          {editing ? "Done" : "Edit"}
        </span>
      </div>
      {editing ? (
        <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
          {allOptions.map(opt => {
            const on = set.has(opt);
            return (
              <span key={opt} onClick={() => { const next = on ? selected.filter(x=>x!==opt) : [...selected,opt]; onChange(next); }}
                style={{ display:"inline-flex", alignItems:"center", borderRadius:999, padding:"3px 10px",
                  fontSize:10, fontWeight:500, border:"0.5px solid", cursor:"pointer", userSelect:"none",
                  ...(on ? (pillStyle||{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder })
                         : { background:"transparent", color:C.textMuted, borderColor:C.borderMid }) }}>
                {on ? "✓ " : ""}{opt}
              </span>
            );
          })}
        </div>
      ) : (
        <div style={{ display:"flex", gap:5, flexWrap:"wrap", minHeight:22 }}>
          {selected.length === 0
            ? <span style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>None set</span>
            : selected.map(opt => (
                <span key={opt} style={{ display:"inline-flex", alignItems:"center", borderRadius:999,
                  padding:"3px 10px", fontSize:10, fontWeight:500, border:"0.5px solid",
                  ...(pillStyle||{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder }) }}>
                  {opt}
                </span>
              ))
          }
        </div>
      )}
    </div>
  );
}

function SellerInfoTab({ seller, editing, draft, setDraft, onSave, onCancelEdit, dispatch, onDeleted }) {
  const { confirmEl, confirm } = useConfirm();
  const [saving, setSaving] = useState(false);

  const update = (key, val) => setDraft(d => ({ ...d, [key]: val }));

  const commitSave = async () => {
    setSaving(true);
    try {
      const updates = {
        company_name: draft.company_name, first_name: draft.first_name, last_name: draft.last_name,
        phone: draft.phone, email: draft.email, domicile: draft.domicile, bank: draft.bank,
        monthly_qty: draft.monthly_qty, status: draft.status, rating: draft.rating,
        mandate: draft.mandate, intermediary: draft.intermediary, notes: draft.notes,
        capabilities: draft.capabilities||[], commodities: draft.commodities||[],
        destinations: draft.destinations||[],
      };
      await sb.update("sellers", seller.id, updates);
      dispatch({ type:"UPDATE_SELLER", id:seller.id, updates });
      onSave();
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const archiveSeller = async () => {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/sellers?id=eq.${encodeURIComponent(seller.id)}`, {
        method:"PATCH",
        headers:{ apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json", Prefer:"return=representation" },
        body: JSON.stringify({ status:"inactive" })
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`${r.status}: ${t}`); }
      const rows = await r.json();
      if (!rows || rows.length === 0) {
        alert("Archive failed: the sellers table may not have a 'status' column.\n\nRun in Supabase SQL editor:\nALTER TABLE sellers ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';");
        return;
      }
      dispatch({ type:"UPDATE_SELLER", id:seller.id, updates:{ status:"inactive" } });
      onDeleted();
    } catch(e) {
      console.error(e);
      alert(`Archive seller failed: ${e.message}`);
    }
  };

  const deleteSeller = async () => {
    if (!await confirm(`Delete "${seller.company_name || "this seller"}"? This cannot be undone.`)) return;
    try {
      await sb.delete("sellers", seller.id);
      dispatch({ type:"DELETE_SELLER", id:seller.id });
      onDeleted();
    } catch(e) { console.error(e); }
  };

  const reactivateSeller = async () => {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/sellers?id=eq.${encodeURIComponent(seller.id)}`, {
        method:"PATCH",
        headers:{ apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json", Prefer:"return=representation" },
        body: JSON.stringify({ status:"active" })
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`${r.status}: ${t}`); }
      const rows = await r.json();
      if (!rows || rows.length === 0) {
        alert("Reactivate failed: sellers table may not have a 'status' column.\n\nRun: ALTER TABLE sellers ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';");
        return;
      }
      dispatch({ type:"UPDATE_SELLER", id:seller.id, updates:{ status:"active" } });
    } catch(e) {
      console.error(e);
      alert(`Reactivate seller failed: ${e.message}`);
    }
  };

  const F = ({ label, fieldKey, span=1 }) => (
    <div style={{ gridColumn: span > 1 ? `span ${span}` : undefined }}>
      <SectionLabel>{label}</SectionLabel>
      {editing ? (
        <input value={draft[fieldKey]||""} onChange={e => update(fieldKey, e.target.value)}
          style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px",
            fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
      ) : (
        <div style={{ fontSize:12, color: seller[fieldKey] ? C.text : C.textDim }}>
          {seller[fieldKey] || "—"}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:13 }}>
        {/* Basic fields grid */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <F label="Phone"       fieldKey="phone" />
          <F label="Email"       fieldKey="email" />
          <F label="Domicile"    fieldKey="domicile" />
          <F label="Bank"        fieldKey="bank" />
          <F label="Monthly qty" fieldKey="monthly_qty" />
          <div>
            <SectionLabel>Status</SectionLabel>
            {editing ? (
              <select value={draft.status||"active"} onChange={e => update("status", e.target.value)}
                style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", color:C.text }}>
                {SELLER_STATUSES.map(s => <option key={s} value={s}>{SELLER_STATUS_LABEL[s]}</option>)}
              </select>
            ) : <SellerStatusPill status={seller.status} />}
          </div>
          <div>
            <SectionLabel>Rating</SectionLabel>
            <StarRating value={editing ? draft.rating||0 : seller.rating||0}
              onChange={editing ? v => update("rating", v) : null} />
          </div>
          <F label="Mandate"     fieldKey="mandate" />
        </div>

        <Divider />

        {/* Pill group fields */}
        <PillToggleGroup
          label="Capabilities"
          allOptions={INSTRUMENTS}
          selected={editing ? draft.capabilities||[] : seller.capabilities||[]}
          onChange={v => update("capabilities", v)}
          pillStyle={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder }}
        />
        <PillToggleGroup
          label="Commodities"
          allOptions={COMMODITIES}
          selected={editing ? draft.commodities||[] : seller.commodities||[]}
          onChange={v => update("commodities", v)}
          pillStyle={{ background:"#fef9ee", color:"#92400e", borderColor:"#fcd34d" }}
        />
        <PillToggleGroup
          label="Export destinations"
          allOptions={DESTINATIONS}
          selected={editing ? draft.destinations||[] : seller.destinations||[]}
          onChange={v => update("destinations", v)}
          pillStyle={{ background:C.bgSecondary, color:C.textMuted, borderColor:C.border }}
        />

        <Divider />

        <div>
          <SectionLabel>Notes</SectionLabel>
          {editing ? (
            <textarea dir="ltr" value={draft.notes||""} onChange={e => update("notes", e.target.value)} rows={3}
              style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"6px 8px",
                fontSize:12, fontFamily:"inherit", resize:"none", outline:"none", color:C.text, lineHeight:1.6 }} />
          ) : (
            <div style={{ fontSize:12, color: seller.notes ? C.text : C.textDim, lineHeight:1.6, whiteSpace:"pre-wrap", wordBreak:"break-word", fontStyle: seller.notes ? "normal" : "italic" }}>
              {seller.notes || "No notes"}
            </div>
          )}
        </div>

        {editing && (
          <div style={{ display:"flex", gap:6 }}>
            <Btn onClick={onCancelEdit}>Cancel</Btn>
            <Btn variant="solid" onClick={commitSave}>{saving ? "Saving…" : "Save changes"}</Btn>
          </div>
        )}
      </div>

      {/* Archive / Reactivate / Delete — pinned outside scroll */}
      {!editing && (
        <div style={{ padding:"10px 16px", borderTop:`0.5px solid ${C.border}`, display:"flex", gap:6, flexShrink:0 }}>
          {seller.status === "inactive" ? (
            <Btn variant="teal" onClick={reactivateSeller}>✓ Reactivate</Btn>
          ) : (
            <Btn onClick={archiveSeller}>🗄 Archive</Btn>
          )}
          <Btn variant="red" onClick={deleteSeller}>🗑 Delete</Btn>
        </div>
      )}
      {confirmEl}
    </div>
  );
}

function SellerContactsTab({ seller, dispatch }) {
  const contacts = Array.isArray(seller.contacts) ? seller.contacts : [];
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(""); const [role, setRole] = useState("");
  const [phone, setPhone] = useState(""); const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  const addContact = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const updated = [...contacts, { id:genId(), name:name.trim(), role:role.trim(), phone:phone.trim(), email:email.trim() }];
    try {
      await sb.update("sellers", seller.id, { contacts: updated });
      dispatch({ type:"UPDATE_SELLER", id:seller.id, updates:{ contacts:updated } });
      setName(""); setRole(""); setPhone(""); setEmail(""); setShowForm(false);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const deleteContact = async (cid) => {
    const updated = contacts.filter(c => c.id !== cid);
    try {
      await sb.update("sellers", seller.id, { contacts: updated });
      dispatch({ type:"UPDATE_SELLER", id:seller.id, updates:{ contacts:updated } });
    } catch(e) { console.error(e); }
  };

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:10 }}>
      {contacts.length === 0 && !showForm && (
        <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No contacts yet</div>
      )}
      {contacts.map(c => (
        <div key={c.id} style={{ border:`0.5px solid ${C.border}`, borderRadius:8, padding:"10px 12px", display:"flex", gap:10, alignItems:"flex-start" }}>
          <div style={{ flex:1, display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
            <div><SectionLabel>Name</SectionLabel><div style={{ fontSize:12, color:C.text, fontWeight:500 }}>{c.name}</div></div>
            <div><SectionLabel>Role</SectionLabel><div style={{ fontSize:12, color:C.textMuted }}>{c.role||"—"}</div></div>
            <div><SectionLabel>Phone</SectionLabel><div style={{ fontSize:12, color:C.text }}>{c.phone||"—"}</div></div>
            <div><SectionLabel>Email</SectionLabel><div style={{ fontSize:12, color:C.text }}>{c.email||"—"}</div></div>
          </div>
          <span onClick={() => deleteContact(c.id)} style={{ fontSize:12, color:C.textDim, cursor:"pointer", flexShrink:0 }}>🗑</span>
        </div>
      ))}
      {showForm ? (
        <div style={{ border:`0.5px solid ${C.tealBorder}`, borderRadius:8, padding:"12px", background:C.tealLight, display:"flex", flexDirection:"column", gap:8 }}>
          <SectionLabel>New contact</SectionLabel>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}>
            {[["Name","name",name,setName],["Role","role",role,setRole],["Phone","phone",phone,setPhone],["Email","email",email,setEmail]].map(([lbl,,val,set]) => (
              <div key={lbl}>
                <SectionLabel>{lbl}</SectionLabel>
                <input value={val} onChange={e => set(e.target.value)}
                  style={{ width:"100%", border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", outline:"none", background:"white", color:C.text }} />
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
            <Btn onClick={() => setShowForm(false)}>Cancel</Btn>
            <Btn variant="solid" onClick={addContact}>{saving ? "Saving…" : "Add contact"}</Btn>
          </div>
        </div>
      ) : (
        <span onClick={() => setShowForm(true)}
          style={{ fontSize:10, color:C.teal, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:4 }}>
          + Add contact
        </span>
      )}
    </div>
  );
}

function SellerDealsTab({ seller, state, onNavigate }) {
  const linked = Object.values(state.dealSellers).filter(ds => ds.seller_id === seller.id);
  return (
    <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:8 }}>
      {linked.length === 0 && (
        <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No deals linked to this seller</div>
      )}
      {linked.map(ds => {
        const deal = state.deals[ds.deal_id];
        if (!deal) return null;
        return (
          <div key={ds.id}
            onClick={() => onNavigate && onNavigate({ view:"board", dealId:ds.deal_id })}
            style={{ border:`0.5px solid ${C.border}`, borderRadius:8, padding:"10px 12px",
              display:"flex", alignItems:"center", gap:10,
              cursor: onNavigate ? "pointer" : "default",
              transition:"background 0.1s" }}
            onMouseEnter={e => { if (onNavigate) e.currentTarget.style.background = C.bgSecondary; }}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, fontWeight:500, color:C.text, marginBottom:3 }}>{deal.deal_name||deal.name||deal.id}</div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                <StatePill state={deal.state||deal.status||"potential"} />
                {deal.instrument && <InstrPill instrument={deal.instrument} />}
                {ds.role && <Pill style={{ background:C.bgSecondary, color:C.textMuted, borderColor:C.border, fontSize:9 }}>{ds.role}</Pill>}
              </div>
            </div>
            {onNavigate && <span style={{ fontSize:12, color:C.textDim }}>→</span>}
          </div>
        );
      })}
    </div>
  );
}

function SellerDetail({ seller, state, dispatch, onDeleted, onNavigate }) {
  const [tab, setTab] = useState("info");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});

  const sellerId = seller.id;
  useEffect(() => {
    setTab("info"); setEditing(false); setDraft({});
  }, [sellerId]);

  const startEdit = () => { setDraft({ ...seller }); setEditing(true); };
  const cancelEdit = () => { setDraft({}); setEditing(false); };
  const onSave = () => { setEditing(false); setDraft({}); };

  const displayName = seller.company_name || `${seller.first_name||""} ${seller.last_name||""}`.trim() || seller.id;
  const location = seller.domicile || "";
  const statusC = SELLER_STATUS_COLOUR[seller.status] || SELLER_STATUS_COLOUR.inactive;

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      {/* Panel header */}
      <div style={{ padding:"12px 16px 0", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:4 }}>
          {editing ? (
            <input
              value={draft.company_name ?? seller.company_name ?? ""}
              onChange={e => setDraft(d => ({ ...d, company_name: e.target.value }))}
              placeholder="Seller name…"
              style={{ fontSize:16, fontWeight:500, color:C.text, border:`0.5px solid ${C.borderMid}`,
                borderRadius:6, padding:"3px 8px", outline:"none", fontFamily:"inherit", flex:1, marginRight:10 }}
            />
          ) : (
            <div style={{ fontSize:16, fontWeight:500, color:C.text }}>{displayName}</div>
          )}
          {!editing && <Btn onClick={startEdit} style={{ fontSize:10, padding:"3px 12px" }}>Edit</Btn>}
        </div>
        <div style={{ fontSize:10, color:C.textMuted, marginBottom:10, display:"flex", alignItems:"center", gap:8 }}>
          {location && <span>{location}</span>}
          {location && <span>·</span>}
          <span style={{ color:statusC.text }}>{SELLER_STATUS_LABEL[seller.status]||seller.status}</span>
          {(seller.rating > 0) && <><span>·</span><StarRating value={seller.rating||0} /></>}
        </div>
        {/* Tabs */}
        <div style={{ display:"flex" }}>
          {["info","contacts","deals"].map(t => (
            <span key={t} onClick={() => setTab(t)} style={{
              flex:1, textAlign:"center", padding:"7px 4px", fontSize:11, fontWeight:500,
              cursor:"pointer", userSelect:"none",
              color: tab===t ? C.tealText : C.textMuted,
              borderBottom: tab===t ? `2px solid ${C.teal}` : "2px solid transparent",
            }}>{t.charAt(0).toUpperCase()+t.slice(1)}</span>
          ))}
        </div>
      </div>

      {tab==="info"     && <SellerInfoTab seller={editing ? {...seller,...draft} : seller} editing={editing} draft={draft} setDraft={setDraft} onSave={onSave} onCancelEdit={cancelEdit} dispatch={dispatch} onDeleted={onDeleted} />}
      {tab==="contacts" && <SellerContactsTab seller={seller} dispatch={dispatch} />}
      {tab==="deals"    && <SellerDealsTab seller={seller} state={state} onNavigate={onNavigate} />}
    </div>
  );
}

function AddSellerForm({ onSave, onCancel }) {
  const [companyName, setCompanyName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [domicile, setDomicile] = useState("");
  const [status, setStatus] = useState("potential");
  const [saving, setSaving] = useState(false);

  const save = async (dispatch) => {
    if (!companyName.trim() && !firstName.trim()) return;
    setSaving(true);
    try {
      const seller = {
        id: genId(), company_name: companyName.trim(), first_name: firstName.trim(),
        last_name: lastName.trim(), domicile: domicile.trim(), status,
        phone:"", email:"", bank:"", monthly_qty:"", rating:0,
        capabilities:[], commodities:[], destinations:[],
        mandate:"", intermediary:"", notes:"", contacts:[],
        created_at: nowISO(),
      };
      await sb.insert("sellers", seller);
      onSave(seller);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  return { companyName, setCompanyName, firstName, setFirstName, lastName, setLastName, domicile, setDomicile, status, setStatus, saving, save };
}

function SellerRegistryScreen({ state, dispatch, searchNav, onNavigate }) {
  const [leftWidth, onDragLeft] = useDraggablePanel(240, 160, 420);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    if (searchNav?.selectedId) { setSelectedId(searchNav.selectedId); setShowAddForm(false); }
  }, [searchNav]);

  // Add form state
  const [newCompany, setNewCompany] = useState("");
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newDomicile, setNewDomicile] = useState("");
  const [newStatus, setNewStatus] = useState("potential");
  const [addSaving, setAddSaving] = useState(false);

  const sellers = Object.values(state.sellers)
    .filter(s => {
      const q = search.toLowerCase();
      if (!q) return true;
      const name = (s.company_name||`${s.first_name||""} ${s.last_name||""}`).toLowerCase();
      return name.includes(q) || (s.domicile||"").toLowerCase().includes(q);
    })
    .sort((a,b) => {
      const na = a.company_name||`${a.first_name||""} ${a.last_name||""}`;
      const nb = b.company_name||`${b.first_name||""} ${b.last_name||""}`;
      return na.localeCompare(nb);
    });

  const selected = selectedId ? state.sellers[selectedId] : null;

  const saveNewSeller = async () => {
    if (!newCompany.trim() && !newFirst.trim()) return;
    setAddSaving(true);
    try {
      const seller = {
        id: genId(), company_name: newCompany.trim(), first_name: newFirst.trim(),
        last_name: newLast.trim(), domicile: newDomicile.trim(), status: newStatus,
        phone:"", email:"", bank:"", monthly_qty:"", rating:0,
        capabilities:[], commodities:[], destinations:[],
        mandate:"", intermediary:"", notes:"", contacts:[],
        created_at: nowISO(),
      };
      await sb.insert("sellers", seller);
      dispatch({ type:"ADD_SELLER", seller });
      setSelectedId(seller.id);
      setShowAddForm(false);
      setNewCompany(""); setNewFirst(""); setNewLast(""); setNewDomicile(""); setNewStatus("potential");
    } catch(e) { console.error(e); }
    setAddSaving(false);
  };

  const sellerDisplayName = (s) => s.company_name || `${s.first_name||""} ${s.last_name||""}`.trim() || s.id;

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>

      {/* ── LEFT LIST ── */}
      <div style={{ width:leftWidth, borderRight:"none", display:"flex", flexDirection:"column", flexShrink:0 }}>
        <div style={{ padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span style={{ fontSize:13, fontWeight:500, color:C.text }}>Sellers</span>
          <Pill onClick={() => { setShowAddForm(true); setSelectedId(null); }}
            style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:10, padding:"3px 11px", cursor:"pointer" }}>+ Add</Pill>
        </div>
        <div style={{ padding:"8px 10px", borderBottom:`0.5px solid ${C.border}` }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search sellers…"
            style={{ width:"100%", border:`0.5px solid ${C.border}`, borderRadius:6, padding:"5px 8px",
              fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
        </div>
        <div style={{ flex:1, overflowY:"auto" }}>
          {sellers.map(s => {
            const active = selectedId === s.id;
            const name = sellerDisplayName(s);
            const statusC = SELLER_STATUS_COLOUR[s.status] || SELLER_STATUS_COLOUR.inactive;
            return (
              <div key={s.id} onClick={() => { setSelectedId(s.id); setShowAddForm(false); }}
                style={{ padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, cursor:"pointer",
                  background: active ? C.tealLight : "transparent",
                  borderLeft: active ? `2px solid ${C.teal}` : "2px solid transparent",
                  opacity: s.status === "inactive" ? 0.6 : 1 }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.bgSecondary; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                <div style={{ fontSize:12, fontWeight:500, color:C.text }}>{name}</div>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:3 }}>
                  <Pill style={{ background:statusC.bg, color:statusC.text, borderColor:statusC.border, fontSize:9, padding:"1px 6px" }}>
                    {SELLER_STATUS_LABEL[s.status]||s.status}
                  </Pill>
                  {s.domicile && <span style={{ fontSize:10, color:C.textDim }}>{s.domicile}</span>}
                  {(s.rating > 0) && <span style={{ fontSize:11, marginLeft:"auto", color:"#f59e0b" }}>{"★".repeat(s.rating)}{"☆".repeat(3-s.rating)}</span>}
                </div>
              </div>
            );
          })}
          {sellers.length === 0 && (
            <div style={{ padding:20, fontSize:11, color:C.textDim, fontStyle:"italic", textAlign:"center" }}>
              {search ? "No sellers match" : "No sellers yet"}
            </div>
          )}
        </div>
      </div>

      <DragHandle onMouseDown={onDragLeft} />

      {/* ── RIGHT PANEL ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", borderLeft:`0.5px solid ${C.border}` }}>
        {showAddForm ? (
          <>
            <div style={{ padding:"14px 16px 10px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader }}>
              <div style={{ fontSize:10, color:C.textMuted, textTransform:"uppercase", letterSpacing:"0.05em" }}>New seller</div>
              <div style={{ fontSize:13, color:C.textDim, marginTop:4 }}>Fill in the details below</div>
            </div>
            <div style={{ flex:1, padding:"14px 16px", display:"flex", flexDirection:"column", gap:12, overflowY:"auto" }}>
              <div>
                <SectionLabel>Company name</SectionLabel>
                <input value={newCompany} onChange={e => setNewCompany(e.target.value)} autoFocus
                  placeholder="e.g. KTI Industries"
                  style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:14, fontWeight:500, fontFamily:"inherit", outline:"none", color:C.text }} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div>
                  <SectionLabel>First name</SectionLabel>
                  <input value={newFirst} onChange={e => setNewFirst(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div>
                  <SectionLabel>Last name</SectionLabel>
                  <input value={newLast} onChange={e => setNewLast(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div>
                  <SectionLabel>Domicile</SectionLabel>
                  <input value={newDomicile} onChange={e => setNewDomicile(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div>
                  <SectionLabel>Status</SectionLabel>
                  <select value={newStatus} onChange={e => setNewStatus(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", color:C.text }}>
                    {SELLER_STATUSES.map(s => <option key={s} value={s}>{SELLER_STATUS_LABEL[s]}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display:"flex", gap:7, justifyContent:"flex-end" }}>
                <Btn onClick={() => setShowAddForm(false)}>Cancel</Btn>
                <Btn variant="solid" onClick={saveNewSeller}>{addSaving ? "Saving…" : "Save seller"}</Btn>
              </div>
            </div>
          </>
        ) : selected ? (
          <SellerDetail
            key={selected.id}
            seller={selected}
            state={state}
            dispatch={dispatch}
            onDeleted={() => setSelectedId(null)}
            onNavigate={onNavigate}
          />
        ) : (
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8, color:C.textDim }}>
            <div style={{ fontSize:28, opacity:0.2 }}>◆</div>
            <div style={{ fontSize:12, color:C.textDim }}>Select a seller or add a new one</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── BUYER REGISTRY ──
const BUYER_STATUSES = ["active","potential","dormant"];
const BUYER_STATUS_LABEL = { active:"Active", potential:"Potential", dormant:"Dormant" };
const BUYER_STATUS_COLOUR = {
  active:   { bg:C.blueLight,    text:C.blue,       border:C.blueBorder },
  potential:{ bg:C.amberLight,   text:C.amber,      border:C.amberBorder },
  dormant:  { bg:C.bgSecondary,  text:C.textMuted,  border:C.border },
};
const DELIVERY_PREFS = ["CIF","FOB","DDP","Ex-Works","Other"];
const RELATIONSHIP_TYPES = ["direct","intermediary","referral","repeat"];

function BuyerStatusPill({ status }) {
  const s = BUYER_STATUS_COLOUR[status] || BUYER_STATUS_COLOUR.dormant;
  return <Pill style={{ background:s.bg, color:s.text, borderColor:s.border, fontSize:10 }}>{BUYER_STATUS_LABEL[status]||status}</Pill>;
}

function BuyerInfoTab({ buyer, editing, draft, setDraft, onSave, onCancelEdit, dispatch, onDeleted }) {
  const { confirmEl, confirm } = useConfirm();
  const [saving, setSaving] = useState(false);

  const update = (key, val) => setDraft(d => ({ ...d, [key]: val }));

  const commitSave = async () => {
    setSaving(true);
    try {
      const updates = {
        company_name: draft.company_name, first_name: draft.first_name, last_name: draft.last_name,
        phone: draft.phone, email: draft.email, location: draft.location,
        min_qty: draft.min_qty, max_qty: draft.max_qty, status: draft.status,
        delivery_preference: draft.delivery_preference, relationship_type: draft.relationship_type,
        notes: draft.notes, instruments: draft.instruments||[], commodities: draft.commodities||[],
      };
      await sb.update("buyers", buyer.id, updates);
      dispatch({ type:"UPDATE_BUYER", id:buyer.id, updates });
      onSave();
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const archiveBuyer = async () => {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/buyers?id=eq.${encodeURIComponent(buyer.id)}`, {
        method:"PATCH",
        headers:{ apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json", Prefer:"return=representation" },
        body: JSON.stringify({ status:"dormant" })
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`${r.status}: ${t}`); }
      const rows = await r.json();
      if (!rows || rows.length === 0) {
        alert("Archive failed: the buyers table may not have a 'status' column.\n\nRun in Supabase SQL editor:\nALTER TABLE buyers ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';");
        return;
      }
      dispatch({ type:"UPDATE_BUYER", id:buyer.id, updates:{ status:"dormant" } });
      onDeleted();
    } catch(e) {
      console.error(e);
      alert(`Archive buyer failed: ${e.message}`);
    }
  };

  const deleteBuyer = async () => {
    if (!await confirm(`Delete "${buyer.company_name || "this buyer"}"? This cannot be undone.`)) return;
    try {
      await sb.delete("buyers", buyer.id);
      dispatch({ type:"DELETE_BUYER", id:buyer.id });
      onDeleted();
    } catch(e) { console.error(e); }
  };

  const reactivateBuyer = async () => {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/buyers?id=eq.${encodeURIComponent(buyer.id)}`, {
        method:"PATCH",
        headers:{ apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json", Prefer:"return=representation" },
        body: JSON.stringify({ status:"active" })
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`${r.status}: ${t}`); }
      const rows = await r.json();
      if (!rows || rows.length === 0) {
        alert("Reactivate failed: buyers table may not have a 'status' column.\n\nRun: ALTER TABLE buyers ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';");
        return;
      }
      dispatch({ type:"UPDATE_BUYER", id:buyer.id, updates:{ status:"active" } });
    } catch(e) {
      console.error(e);
      alert(`Reactivate buyer failed: ${e.message}`);
    }
  };

  const F = ({ label, fieldKey, span }) => (
    <div style={{ gridColumn: span ? `span ${span}` : undefined }}>
      <SectionLabel>{label}</SectionLabel>
      {editing ? (
        <input value={draft[fieldKey]||""} onChange={e => update(fieldKey, e.target.value)}
          style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px",
            fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
      ) : (
        <div style={{ fontSize:12, color: buyer[fieldKey] ? C.text : C.textDim }}>{buyer[fieldKey]||"—"}</div>
      )}
    </div>
  );

  const isDud = (buyer.notes||"").toUpperCase().includes("DUD");

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:13 }}>

        {/* DUD warning banner */}
        {isDud && (
          <div style={{ background:C.redLight, border:`1px solid ${C.redBorder}`, borderRadius:8, padding:"10px 12px", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:16 }}>⚠️</span>
            <div>
              <div style={{ fontSize:12, fontWeight:600, color:C.red }}>Do not engage</div>
              <div style={{ fontSize:11, color:C.red, marginTop:2 }}>This buyer is flagged as a DUD in notes.</div>
            </div>
          </div>
        )}

        {/* Fields grid */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <F label="Phone"       fieldKey="phone" />
          <F label="Email"       fieldKey="email" />
          <div>
            <SectionLabel>Location</SectionLabel>
            {editing ? (
              <select value={draft.location||""} onChange={e => update("location", e.target.value)}
                style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", color:C.text, background:"white" }}>
                <option value="">— Select location —</option>
                {["Americas","Europe","Britain","Dubai","Hong Kong","Turkey","South America","Oman","Other"].map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            ) : (
              <div style={{ fontSize:12, color: buyer.location ? C.text : C.textDim }}>{buyer.location||"—"}</div>
            )}
          </div>
          <div>
            <SectionLabel>Status</SectionLabel>
            {editing ? (
              <select value={draft.status||"potential"} onChange={e => update("status", e.target.value)}
                style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", color:C.text }}>
                {BUYER_STATUSES.map(s => <option key={s} value={s}>{BUYER_STATUS_LABEL[s]}</option>)}
              </select>
            ) : <BuyerStatusPill status={buyer.status} />}
          </div>
          <F label="Min quantity" fieldKey="min_qty" />
          <F label="Max quantity" fieldKey="max_qty" />
          <div>
            <SectionLabel>Delivery preference</SectionLabel>
            {editing ? (
              <select value={draft.delivery_preference||""} onChange={e => update("delivery_preference", e.target.value)}
                style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", color:C.text }}>
                <option value="">— None</option>
                {DELIVERY_PREFS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <div style={{ fontSize:12, color: buyer.delivery_preference ? C.text : C.textDim }}>{buyer.delivery_preference||"—"}</div>
            )}
          </div>
          <div>
            <SectionLabel>Relationship type</SectionLabel>
            {editing ? (
              <select value={draft.relationship_type||"direct"} onChange={e => update("relationship_type", e.target.value)}
                style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", color:C.text }}>
                {RELATIONSHIP_TYPES.map(r => <option key={r} value={r}>{r.charAt(0).toUpperCase()+r.slice(1)}</option>)}
              </select>
            ) : (
              <div style={{ fontSize:12, color: buyer.relationship_type ? C.text : C.textDim }}>{buyer.relationship_type||"—"}</div>
            )}
          </div>
        </div>

        <Divider />

        {/* Instruments pill toggle */}
        <PillToggleGroup
          label="Instruments"
          allOptions={INSTRUMENTS}
          selected={editing ? draft.instruments||[] : buyer.instruments||[]}
          onChange={v => update("instruments", v)}
          pillStyle={{ background:C.blueLight, color:C.blue, borderColor:C.blueBorder }}
        />
        <PillToggleGroup
          label="Commodities"
          allOptions={COMMODITIES}
          selected={editing ? draft.commodities||[] : buyer.commodities||[]}
          onChange={v => update("commodities", v)}
          pillStyle={{ background:"#fef9ee", color:"#92400e", borderColor:"#fcd34d" }}
        />

        <Divider />

        <div>
          <SectionLabel>Notes</SectionLabel>
          {editing ? (
            <textarea dir="ltr" value={draft.notes||""} onChange={e => update("notes", e.target.value)} rows={3}
              style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"6px 8px",
                fontSize:12, fontFamily:"inherit", resize:"none", outline:"none", color:C.text, lineHeight:1.6 }} />
          ) : (
            <div style={{ fontSize:12, color: buyer.notes ? C.text : C.textDim, lineHeight:1.6, whiteSpace:"pre-wrap", wordBreak:"break-word", fontStyle: buyer.notes ? "normal" : "italic" }}>
              {buyer.notes||"No notes"}
            </div>
          )}
        </div>

        {editing && (
          <div style={{ display:"flex", gap:6 }}>
            <Btn onClick={onCancelEdit}>Cancel</Btn>
            <Btn style={{ background:C.blue, color:"#fff", borderColor:C.blue }} onClick={commitSave}>{saving ? "Saving…" : "Save changes"}</Btn>
          </div>
        )}
      </div>

      {/* Archive / Reactivate / Delete pinned */}
      {!editing && (
        <div style={{ padding:"10px 16px", borderTop:`0.5px solid ${C.border}`, display:"flex", gap:6, flexShrink:0 }}>
          {buyer.status === "dormant" ? (
            <Btn variant="teal" onClick={reactivateBuyer}>✓ Reactivate</Btn>
          ) : (
            <Btn onClick={archiveBuyer}>🗄 Archive</Btn>
          )}
          <Btn variant="red" onClick={deleteBuyer}>🗑 Delete</Btn>
        </div>
      )}
      {confirmEl}
    </div>
  );
}

function BuyerContactsTab({ buyer, dispatch }) {
  const contacts = Array.isArray(buyer.contacts) ? buyer.contacts : [];
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(""); const [role, setRole] = useState("");
  const [phone, setPhone] = useState(""); const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  const addContact = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const updated = [...contacts, { id:genId(), name:name.trim(), role:role.trim(), phone:phone.trim(), email:email.trim() }];
    try {
      await sb.update("buyers", buyer.id, { contacts: updated });
      dispatch({ type:"UPDATE_BUYER", id:buyer.id, updates:{ contacts:updated } });
      setName(""); setRole(""); setPhone(""); setEmail(""); setShowForm(false);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const deleteContact = async (cid) => {
    const updated = contacts.filter(c => c.id !== cid);
    try {
      await sb.update("buyers", buyer.id, { contacts: updated });
      dispatch({ type:"UPDATE_BUYER", id:buyer.id, updates:{ contacts:updated } });
    } catch(e) { console.error(e); }
  };

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:10 }}>
      {contacts.length === 0 && !showForm && (
        <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No contacts yet</div>
      )}
      {contacts.map(c => (
        <div key={c.id} style={{ border:`0.5px solid ${C.border}`, borderRadius:8, padding:"10px 12px", display:"flex", gap:10, alignItems:"flex-start" }}>
          <div style={{ flex:1, display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
            <div><SectionLabel>Name</SectionLabel><div style={{ fontSize:12, color:C.text, fontWeight:500 }}>{c.name}</div></div>
            <div><SectionLabel>Role</SectionLabel><div style={{ fontSize:12, color:C.textMuted }}>{c.role||"—"}</div></div>
            <div><SectionLabel>Phone</SectionLabel><div style={{ fontSize:12, color:C.text }}>{c.phone||"—"}</div></div>
            <div><SectionLabel>Email</SectionLabel><div style={{ fontSize:12, color:C.text }}>{c.email||"—"}</div></div>
          </div>
          <span onClick={() => deleteContact(c.id)} style={{ fontSize:12, color:C.textDim, cursor:"pointer", flexShrink:0 }}>🗑</span>
        </div>
      ))}
      {showForm ? (
        <div style={{ border:`0.5px solid ${C.blueBorder}`, borderRadius:8, padding:"12px", background:C.blueLight, display:"flex", flexDirection:"column", gap:8 }}>
          <SectionLabel>New contact</SectionLabel>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}>
            {[["Name",name,setName],["Role",role,setRole],["Phone",phone,setPhone],["Email",email,setEmail]].map(([lbl,val,set]) => (
              <div key={lbl}>
                <SectionLabel>{lbl}</SectionLabel>
                <input value={val} onChange={e => set(e.target.value)}
                  style={{ width:"100%", border:`0.5px solid ${C.blueBorder}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", outline:"none", background:"white", color:C.text }} />
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
            <Btn onClick={() => setShowForm(false)}>Cancel</Btn>
            <Btn style={{ background:C.blue, color:"#fff", borderColor:C.blue }} onClick={addContact}>{saving ? "Saving…" : "Add contact"}</Btn>
          </div>
        </div>
      ) : (
        <span onClick={() => setShowForm(true)}
          style={{ fontSize:10, color:C.blue, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:4 }}>
          + Add contact
        </span>
      )}
    </div>
  );
}

function BuyerDealsTab({ buyer, state, onNavigate }) {
  const deals = Object.values(state.deals).filter(d => d.buyer_id === buyer.id && !d.archived);
  return (
    <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:8 }}>
      {deals.length === 0 && (
        <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No deals for this buyer</div>
      )}
      {deals.map(deal => (
        <div key={deal.id}
          onClick={() => onNavigate && onNavigate({ view:"board", dealId:deal.id })}
          style={{ border:`0.5px solid ${C.border}`, borderRadius:8, padding:"10px 12px",
            cursor: onNavigate ? "pointer" : "default", transition:"background 0.1s" }}
          onMouseEnter={e => { if (onNavigate) e.currentTarget.style.background = C.bgSecondary; }}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div style={{ fontSize:12, fontWeight:500, color:C.text, marginBottom:4 }}>{deal.deal_name||deal.name||deal.id}</div>
            {onNavigate && <span style={{ fontSize:12, color:C.textDim }}>→</span>}
          </div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            <StatePill state={deal.state||deal.status||"potential"} />
            {deal.instrument && <InstrPill instrument={deal.instrument} />}
            {deal.commodity && <CommodityPill commodity={deal.commodity} />}
          </div>
        </div>
      ))}
    </div>
  );
}

function BuyerDetail({ buyer, state, dispatch, onDeleted, onNavigate }) {
  const [tab, setTab] = useState("info");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});

  const buyerId = buyer.id;
  useEffect(() => { setTab("info"); setEditing(false); setDraft({}); }, [buyerId]);

  const startEdit = () => { setDraft({ ...buyer }); setEditing(true); };
  const cancelEdit = () => { setDraft({}); setEditing(false); };
  const onSave = () => { setEditing(false); setDraft({}); };

  const displayName = buyer.company_name || buyer.name || `${buyer.first_name||""} ${buyer.last_name||""}`.trim() || buyer.id;
  const location = buyer.location || "";
  const statusC = BUYER_STATUS_COLOUR[buyer.status] || BUYER_STATUS_COLOUR.dormant;

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{ padding:"12px 16px 0", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:4 }}>
          {editing ? (
            <input
              value={draft.company_name ?? buyer.company_name ?? ""}
              onChange={e => setDraft(d => ({ ...d, company_name: e.target.value }))}
              placeholder="Buyer name…"
              style={{ fontSize:16, fontWeight:500, color:C.text, border:`0.5px solid ${C.borderMid}`,
                borderRadius:6, padding:"3px 8px", outline:"none", fontFamily:"inherit", flex:1, marginRight:10 }}
            />
          ) : (
            <div style={{ fontSize:16, fontWeight:500, color:C.text }}>{displayName}</div>
          )}
          {!editing && <Btn onClick={startEdit} style={{ fontSize:10, padding:"3px 12px" }}>Edit</Btn>}
        </div>
        <div style={{ fontSize:10, color:C.textMuted, marginBottom:10, display:"flex", alignItems:"center", gap:8 }}>
          {location && <span>{location}</span>}
          {location && <span>·</span>}
          <span style={{ color:statusC.text }}>{BUYER_STATUS_LABEL[buyer.status]||buyer.status}</span>
        </div>
        <div style={{ display:"flex" }}>
          {["info","contacts","deals"].map(t => (
            <span key={t} onClick={() => setTab(t)} style={{
              flex:1, textAlign:"center", padding:"7px 4px", fontSize:11, fontWeight:500,
              cursor:"pointer", userSelect:"none",
              color: tab===t ? C.blue : C.textMuted,
              borderBottom: tab===t ? `2px solid ${C.blue}` : "2px solid transparent",
            }}>{t.charAt(0).toUpperCase()+t.slice(1)}</span>
          ))}
        </div>
      </div>

      {tab==="info"     && <BuyerInfoTab buyer={editing ? {...buyer,...draft} : buyer} editing={editing} draft={draft} setDraft={setDraft} onSave={onSave} onCancelEdit={cancelEdit} dispatch={dispatch} onDeleted={onDeleted} />}
      {tab==="contacts" && <BuyerContactsTab buyer={buyer} dispatch={dispatch} />}
      {tab==="deals"    && <BuyerDealsTab buyer={buyer} state={state} onNavigate={onNavigate} />}
    </div>
  );
}

function BuyerRegistryScreen({ state, dispatch, searchNav, onNavigate }) {
  const [leftWidth, onDragLeft] = useDraggablePanel(240, 160, 420);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newCompany, setNewCompany] = useState("");
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newStatus, setNewStatus] = useState("potential");
  const [addSaving, setAddSaving] = useState(false);

  useEffect(() => {
    if (searchNav?.selectedId) { setSelectedId(searchNav.selectedId); setShowAddForm(false); }
  }, [searchNav]);

  const buyers = Object.values(state.buyers)
    .filter(b => {
      const q = search.toLowerCase();
      if (!q) return true;
      const name = (b.company_name||b.name||`${b.first_name||""} ${b.last_name||""}`).toLowerCase();
      return name.includes(q) || (b.location||"").toLowerCase().includes(q);
    })
    .sort((a,b) => {
      const na = a.company_name||a.name||`${a.first_name||""} ${a.last_name||""}`;
      const nb = b.company_name||b.name||`${b.first_name||""} ${b.last_name||""}`;
      return na.localeCompare(nb);
    });

  const selected = selectedId ? state.buyers[selectedId] : null;

  const saveNewBuyer = async () => {
    if (!newCompany.trim() && !newFirst.trim()) return;
    setAddSaving(true);
    try {
      const base = {
        id: genId(), company_name: newCompany.trim(), name: newCompany.trim(),
        first_name: newFirst.trim(), last_name: newLast.trim(),
        location: newLocation.trim(), status: newStatus,
        phone:"", email:"", min_qty:"", max_qty:"",
        delivery_preference:"", relationship_type:"direct",
        notes:"", created_at: nowISO(),
      };
      let buyer;
      try {
        buyer = { ...base, instruments:[], commodities:[], contacts:[] };
        await sb.insert("buyers", buyer);
      } catch(e1) {
        buyer = { ...base };
        await sb.insert("buyers", buyer);
      }
      dispatch({ type:"ADD_BUYER", buyer });
      setSelectedId(buyer.id);
      setShowAddForm(false);
      setNewCompany(""); setNewFirst(""); setNewLast(""); setNewLocation(""); setNewStatus("potential");
    } catch(e) {
      console.error(e);
      alert("Could not save buyer: " + e.message);
    }
    setAddSaving(false);
  };

  const buyerDisplayName = (b) => b.company_name || b.name || `${b.first_name||""} ${b.last_name||""}`.trim() || b.id;
  const isDud = (b) => (b.notes||"").toUpperCase().includes("DUD");

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>

      {/* ── LEFT LIST ── */}
      <div style={{ width:leftWidth, borderRight:"none", display:"flex", flexDirection:"column", flexShrink:0 }}>
        <div style={{ padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span style={{ fontSize:13, fontWeight:500, color:C.text }}>Buyers</span>
          <Pill onClick={() => { setShowAddForm(true); setSelectedId(null); }}
            style={{ background:C.blueLight, color:C.blue, borderColor:C.blueBorder, fontSize:10, padding:"3px 11px", cursor:"pointer" }}>+ Add</Pill>
        </div>
        <div style={{ padding:"8px 10px", borderBottom:`0.5px solid ${C.border}` }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search buyers…"
            style={{ width:"100%", border:`0.5px solid ${C.border}`, borderRadius:6, padding:"5px 8px",
              fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
        </div>
        <div style={{ flex:1, overflowY:"auto" }}>
          {buyers.map(b => {
            const active = selectedId === b.id;
            const name = buyerDisplayName(b);
            const statusC = BUYER_STATUS_COLOUR[b.status] || BUYER_STATUS_COLOUR.dormant;
            const dud = isDud(b);
            return (
              <div key={b.id} onClick={() => { setSelectedId(b.id); setShowAddForm(false); }}
                style={{ padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, cursor:"pointer",
                  background: active ? C.blueLight : "transparent",
                  borderLeft: active ? `2px solid ${C.blue}` : "2px solid transparent",
                  opacity: b.status === "dormant" ? 0.6 : 1 }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.bgSecondary; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                  <div style={{ fontSize:12, fontWeight:500, color:C.text, flex:1 }}>{name}</div>
                  {dud && <span style={{ fontSize:9, color:C.red, fontWeight:600 }}>DUD</span>}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:3 }}>
                  <Pill style={{ background:statusC.bg, color:statusC.text, borderColor:statusC.border, fontSize:9, padding:"1px 6px" }}>
                    {BUYER_STATUS_LABEL[b.status]||b.status}
                  </Pill>
                  {b.location && <span style={{ fontSize:10, color:C.textDim }}>{b.location}</span>}
                </div>
              </div>
            );
          })}
          {buyers.length === 0 && (
            <div style={{ padding:20, fontSize:11, color:C.textDim, fontStyle:"italic", textAlign:"center" }}>
              {search ? "No buyers match" : "No buyers yet"}
            </div>
          )}
        </div>
      </div>

      <DragHandle onMouseDown={onDragLeft} />

      {/* ── RIGHT PANEL ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", borderLeft:`0.5px solid ${C.border}` }}>
        {showAddForm ? (
          <>
            <div style={{ padding:"14px 16px 10px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader }}>
              <div style={{ fontSize:10, color:C.textMuted, textTransform:"uppercase", letterSpacing:"0.05em" }}>New buyer</div>
              <div style={{ fontSize:13, color:C.textDim, marginTop:4 }}>Fill in the details below</div>
            </div>
            <div style={{ flex:1, padding:"14px 16px", display:"flex", flexDirection:"column", gap:12, overflowY:"auto" }}>
              <div>
                <SectionLabel>Company / buyer name</SectionLabel>
                <input value={newCompany} onChange={e => setNewCompany(e.target.value)} autoFocus
                  placeholder="e.g. Gerald Holdings"
                  style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:14, fontWeight:500, fontFamily:"inherit", outline:"none", color:C.text }} />
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div>
                  <SectionLabel>First name</SectionLabel>
                  <input value={newFirst} onChange={e => setNewFirst(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div>
                  <SectionLabel>Last name</SectionLabel>
                  <input value={newLast} onChange={e => setNewLast(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div>
                  <SectionLabel>Location</SectionLabel>
                  <select value={newLocation} onChange={e => setNewLocation(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", color:C.text, background:"white" }}>
                    <option value="">— Select location —</option>
                    {["Americas","Europe","Britain","Dubai","Hong Kong","Turkey","South America","Oman","Other"].map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div>
                  <SectionLabel>Status</SectionLabel>
                  <select value={newStatus} onChange={e => setNewStatus(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", color:C.text }}>
                    {BUYER_STATUSES.map(s => <option key={s} value={s}>{BUYER_STATUS_LABEL[s]}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display:"flex", gap:7, justifyContent:"flex-end" }}>
                <Btn onClick={() => setShowAddForm(false)}>Cancel</Btn>
                <Btn style={{ background:C.blue, color:"#fff", borderColor:C.blue }} onClick={saveNewBuyer}>{addSaving ? "Saving…" : "Save buyer"}</Btn>
              </div>
            </div>
          </>
        ) : selected ? (
          <BuyerDetail
            key={selected.id}
            buyer={selected}
            state={state}
            dispatch={dispatch}
            onDeleted={() => setSelectedId(null)}
            onNavigate={onNavigate}
          />
        ) : (
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8, color:C.textDim }}>
            <div style={{ fontSize:28, opacity:0.2 }}>◇</div>
            <div style={{ fontSize:12, color:C.textDim }}>Select a buyer or add a new one</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── PEOPLE REGISTRY ──
const PEOPLE_STATUSES = ["active","inactive","prospect"];
const PEOPLE_STATUS_LABEL = { active:"Active", inactive:"Inactive", prospect:"Prospect" };
const PEOPLE_STATUS_COLOUR = {
  active:   { bg:C.purpleLight, text:"#5b21b6", border:C.purpleBorder },
  inactive: { bg:C.bgSecondary, text:C.textMuted, border:C.border },
  prospect: { bg:C.amberLight,  text:C.amber,    border:C.amberBorder },
};

function PersonInfoTab({ person, editing, draft, setDraft, onSave, onCancelEdit, dispatch, onDeleted }) {
  const { confirmEl, confirm } = useConfirm();
  const [saving, setSaving] = useState(false);
  const [showPassport, setShowPassport] = useState(false);
  const update = (key, val) => setDraft(d => ({ ...d, [key]: val }));

  const commitSave = async () => {
    setSaving(true);
    try {
      const updates = {
        first_name: draft.first_name, last_name: draft.last_name,
        company: draft.company, role: draft.role, status: draft.status,
        passport_number: draft.passport_number, notes: draft.notes,
      };
      await sb.update("people", person.id, updates);
      dispatch({ type:"UPDATE_PERSON", id:person.id, updates });
      onSave();
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const deletePerson = async () => {
    if (!await confirm(`Delete "${[person.first_name, person.last_name].filter(Boolean).join(" ") || "this person"}"? This cannot be undone.`)) return;
    try {
      await sb.delete("people", person.id);
      dispatch({ type:"DELETE_PERSON", id:person.id });
      onDeleted();
    } catch(e) { console.error(e); }
  };

  const F = ({ label, fieldKey, span }) => (
    <div style={{ gridColumn: span ? `span ${span}` : undefined }}>
      <SectionLabel>{label}</SectionLabel>
      {editing ? (
        <input value={draft[fieldKey]||""} onChange={e => update(fieldKey, e.target.value)}
          style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px",
            fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
      ) : (
        <div style={{ fontSize:12, color: person[fieldKey] ? C.text : C.textDim }}>{person[fieldKey]||"—"}</div>
      )}
    </div>
  );

  const statusC = PEOPLE_STATUS_COLOUR[person.status] || PEOPLE_STATUS_COLOUR.inactive;

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:13 }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <F label="First name" fieldKey="first_name" />
          <F label="Last name"  fieldKey="last_name" />
          <F label="Company"    fieldKey="company" />
          <div>
            <SectionLabel>Status</SectionLabel>
            {editing ? (
              <select value={draft.status||"active"} onChange={e => update("status", e.target.value)}
                style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", color:C.text }}>
                {PEOPLE_STATUSES.map(s => <option key={s} value={s}>{PEOPLE_STATUS_LABEL[s]}</option>)}
              </select>
            ) : <Pill style={{ background:statusC.bg, color:statusC.text, borderColor:statusC.border, fontSize:10 }}>{PEOPLE_STATUS_LABEL[person.status]||person.status}</Pill>}
          </div>
          <F label="Role" fieldKey="role" span={2} />
        </div>

        <Divider />

        {/* Passport — sensitive field, masked by default */}
        <div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
            <SectionLabel>Passport number</SectionLabel>
            <span onClick={() => setShowPassport(v => !v)}
              style={{ fontSize:10, color:C.purple, cursor:"pointer", textDecoration:"underline" }}>
              {showPassport ? "Hide" : "Show"}
            </span>
          </div>
          {editing ? (
            <input value={draft.passport_number||""} onChange={e => update("passport_number", e.target.value)}
              type={showPassport ? "text" : "password"}
              style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"4px 7px",
                fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
          ) : (
            <div style={{ fontSize:12, color: person.passport_number ? C.text : C.textDim, letterSpacing: showPassport ? "normal" : "0.1em" }}>
              {person.passport_number
                ? showPassport ? person.passport_number : "••••••••"
                : "—"}
            </div>
          )}
        </div>

        <Divider />

        <div>
          <SectionLabel>Notes</SectionLabel>
          {editing ? (
            <textarea dir="ltr" value={draft.notes||""} onChange={e => update("notes", e.target.value)} rows={3}
              style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"6px 8px",
                fontSize:12, fontFamily:"inherit", resize:"none", outline:"none", color:C.text, lineHeight:1.6 }} />
          ) : (
            <div style={{ fontSize:12, color: person.notes ? C.text : C.textDim, lineHeight:1.6, whiteSpace:"pre-wrap", wordBreak:"break-word", fontStyle: person.notes ? "normal" : "italic" }}>
              {person.notes||"No notes"}
            </div>
          )}
        </div>

        {editing && (
          <div style={{ display:"flex", gap:6 }}>
            <Btn onClick={onCancelEdit}>Cancel</Btn>
            <Btn style={{ background:C.purple, color:"#fff", borderColor:C.purple }} onClick={commitSave}>{saving ? "Saving…" : "Save changes"}</Btn>
          </div>
        )}
      </div>

      {!editing && (
        <div style={{ padding:"10px 16px", borderTop:`0.5px solid ${C.border}`, display:"flex", gap:6, flexShrink:0 }}>
          <Btn variant="red" onClick={deletePerson}>🗑 Delete</Btn>
        </div>
      )}
      {confirmEl}
    </div>
  );
}

function PersonContactsTab({ person, dispatch }) {
  const contacts = Array.isArray(person.contacts) ? person.contacts : [];
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(""); const [role, setRole] = useState("");
  const [phone, setPhone] = useState(""); const [email, setEmail] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [saving, setSaving] = useState(false);

  const addContact = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const updated = [...contacts, { id:genId(), name:name.trim(), role:role.trim(), phone:phone.trim(), email:email.trim(), whatsapp:whatsapp.trim() }];
    try {
      await sb.update("people", person.id, { contacts: updated });
      dispatch({ type:"UPDATE_PERSON", id:person.id, updates:{ contacts:updated } });
      setName(""); setRole(""); setPhone(""); setEmail(""); setWhatsapp(""); setShowForm(false);
    } catch(e) { console.error(e); }
    setSaving(false);
  };

  const deleteContact = async (cid) => {
    const updated = contacts.filter(c => c.id !== cid);
    try {
      await sb.update("people", person.id, { contacts: updated });
      dispatch({ type:"UPDATE_PERSON", id:person.id, updates:{ contacts:updated } });
    } catch(e) { console.error(e); }
  };

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:10 }}>
      {contacts.length === 0 && !showForm && (
        <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No contacts yet</div>
      )}
      {contacts.map(c => (
        <div key={c.id} style={{ border:`0.5px solid ${C.border}`, borderRadius:8, padding:"10px 12px", display:"flex", gap:10, alignItems:"flex-start" }}>
          <div style={{ flex:1, display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
            <div><SectionLabel>Name</SectionLabel><div style={{ fontSize:12, color:C.text, fontWeight:500 }}>{c.name}</div></div>
            <div><SectionLabel>Role</SectionLabel><div style={{ fontSize:12, color:C.textMuted }}>{c.role||"—"}</div></div>
            <div><SectionLabel>Phone</SectionLabel><div style={{ fontSize:12, color:C.text }}>{c.phone||"—"}</div></div>
            <div><SectionLabel>Email</SectionLabel><div style={{ fontSize:12, color:C.text }}>{c.email||"—"}</div></div>
            {c.whatsapp && <div style={{ gridColumn:"span 2" }}><SectionLabel>WhatsApp</SectionLabel><div style={{ fontSize:12, color:C.text }}>{c.whatsapp}</div></div>}
          </div>
          <span onClick={() => deleteContact(c.id)} style={{ fontSize:12, color:C.textDim, cursor:"pointer", flexShrink:0 }}>🗑</span>
        </div>
      ))}
      {showForm ? (
        <div style={{ border:`0.5px solid ${C.purpleBorder}`, borderRadius:8, padding:"12px", background:C.purpleLight, display:"flex", flexDirection:"column", gap:8 }}>
          <SectionLabel>New contact</SectionLabel>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}>
            {[["Name",name,setName],["Role",role,setRole],["Phone",phone,setPhone],["Email",email,setEmail],["WhatsApp",whatsapp,setWhatsapp]].map(([lbl,val,set]) => (
              <div key={lbl} style={{ gridColumn: lbl==="WhatsApp" ? "span 2" : undefined }}>
                <SectionLabel>{lbl}</SectionLabel>
                <input value={val} onChange={e => set(e.target.value)}
                  style={{ width:"100%", border:`0.5px solid ${C.purpleBorder}`, borderRadius:6, padding:"4px 7px", fontSize:12, fontFamily:"inherit", outline:"none", background:"white", color:C.text }} />
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
            <Btn onClick={() => setShowForm(false)}>Cancel</Btn>
            <Btn style={{ background:C.purple, color:"#fff", borderColor:C.purple }} onClick={addContact}>{saving ? "Saving…" : "Add contact"}</Btn>
          </div>
        </div>
      ) : (
        <span onClick={() => setShowForm(true)}
          style={{ fontSize:10, color:C.purple, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:4 }}>
          + Add contact
        </span>
      )}
    </div>
  );
}

function PersonLinksTab({ person, state, dispatch }) {
  const linkedBuyerIds  = Array.isArray(person.linked_buyers)  ? person.linked_buyers  : [];
  const linkedSellerIds = Array.isArray(person.linked_sellers) ? person.linked_sellers : [];

  const [buyerSearch,  setBuyerSearch]  = useState("");
  const [sellerSearch, setSellerSearch] = useState("");
  const [showBuyerSearch,  setShowBuyerSearch]  = useState(false);
  const [showSellerSearch, setShowSellerSearch] = useState(false);

  const allBuyers  = Object.values(state.buyers);
  const allSellers = Object.values(state.sellers);

  const buyerName  = (b) => b.company_name||b.name||`${b.first_name||""} ${b.last_name||""}`.trim()||b.id;
  const sellerName = (s) => s.company_name||`${s.first_name||""} ${s.last_name||""}`.trim()||s.id;

  const linkBuyer = async (id) => {
    if (linkedBuyerIds.includes(id)) return;
    const updated = [...linkedBuyerIds, id];
    try {
      await sb.update("people", person.id, { linked_buyers: updated });
      dispatch({ type:"UPDATE_PERSON", id:person.id, updates:{ linked_buyers:updated } });
      setBuyerSearch(""); setShowBuyerSearch(false);
    } catch(e) { console.error(e); }
  };

  const unlinkBuyer = async (id) => {
    const updated = linkedBuyerIds.filter(x => x !== id);
    try {
      await sb.update("people", person.id, { linked_buyers: updated });
      dispatch({ type:"UPDATE_PERSON", id:person.id, updates:{ linked_buyers:updated } });
    } catch(e) { console.error(e); }
  };

  const linkSeller = async (id) => {
    if (linkedSellerIds.includes(id)) return;
    const updated = [...linkedSellerIds, id];
    try {
      await sb.update("people", person.id, { linked_sellers: updated });
      dispatch({ type:"UPDATE_PERSON", id:person.id, updates:{ linked_sellers:updated } });
      setSellerSearch(""); setShowSellerSearch(false);
    } catch(e) { console.error(e); }
  };

  const unlinkSeller = async (id) => {
    const updated = linkedSellerIds.filter(x => x !== id);
    try {
      await sb.update("people", person.id, { linked_sellers: updated });
      dispatch({ type:"UPDATE_PERSON", id:person.id, updates:{ linked_sellers:updated } });
    } catch(e) { console.error(e); }
  };

  const buyerResults  = allBuyers.filter(b  => !linkedBuyerIds.includes(b.id)  && buyerName(b).toLowerCase().includes(buyerSearch.toLowerCase()));
  const sellerResults = allSellers.filter(s => !linkedSellerIds.includes(s.id) && sellerName(s).toLowerCase().includes(sellerSearch.toLowerCase()));

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"14px 16px", display:"flex", flexDirection:"column", gap:16 }}>

      {/* Buyers section */}
      <div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
          <SectionLabel>Linked buyers</SectionLabel>
          <span onClick={() => { setShowBuyerSearch(v => !v); setBuyerSearch(""); }}
            style={{ fontSize:10, color:C.blue, cursor:"pointer", textDecoration:"underline" }}>
            {showBuyerSearch ? "Cancel" : "+ Link buyer"}
          </span>
        </div>
        {showBuyerSearch && (
          <div style={{ marginBottom:8, position:"relative" }}>
            <input autoFocus value={buyerSearch} onChange={e => setBuyerSearch(e.target.value)}
              placeholder="Search buyers…"
              style={{ width:"100%", border:`0.5px solid ${C.blueBorder}`, borderRadius:6, padding:"5px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
            {buyerSearch && (
              <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"white", border:`0.5px solid ${C.border}`, borderRadius:6, zIndex:10, boxShadow:"0 4px 12px rgba(0,0,0,0.08)", maxHeight:160, overflowY:"auto" }}>
                {buyerResults.slice(0,8).map(b => (
                  <div key={b.id} onClick={() => linkBuyer(b.id)}
                    style={{ padding:"7px 10px", fontSize:11, cursor:"pointer", color:C.text }}
                    onMouseEnter={e => e.currentTarget.style.background=C.bgSecondary}
                    onMouseLeave={e => e.currentTarget.style.background="white"}>
                    {buyerName(b)}
                  </div>
                ))}
                {buyerResults.length === 0 && <div style={{ padding:"7px 10px", fontSize:11, color:C.textDim, fontStyle:"italic" }}>No matches</div>}
              </div>
            )}
          </div>
        )}
        {linkedBuyerIds.length === 0 && !showBuyerSearch && (
          <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No buyers linked</div>
        )}
        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
          {linkedBuyerIds.map(id => {
            const b = state.buyers[id];
            if (!b) return null;
            return (
              <div key={id} style={{ display:"inline-flex", alignItems:"center", gap:5,
                background:C.blueLight, color:C.blue, borderColor:C.blueBorder,
                border:`0.5px solid ${C.blueBorder}`, borderRadius:999, padding:"4px 10px", fontSize:11 }}>
                {buyerName(b)}
                <span onClick={() => unlinkBuyer(id)} style={{ fontSize:11, color:C.blue, cursor:"pointer", opacity:0.6, marginLeft:2 }}>✕</span>
              </div>
            );
          })}
        </div>
      </div>

      <Divider />

      {/* Sellers section */}
      <div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
          <SectionLabel>Linked sellers</SectionLabel>
          <span onClick={() => { setShowSellerSearch(v => !v); setSellerSearch(""); }}
            style={{ fontSize:10, color:C.teal, cursor:"pointer", textDecoration:"underline" }}>
            {showSellerSearch ? "Cancel" : "+ Link seller"}
          </span>
        </div>
        {showSellerSearch && (
          <div style={{ marginBottom:8, position:"relative" }}>
            <input autoFocus value={sellerSearch} onChange={e => setSellerSearch(e.target.value)}
              placeholder="Search sellers…"
              style={{ width:"100%", border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"5px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
            {sellerSearch && (
              <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"white", border:`0.5px solid ${C.border}`, borderRadius:6, zIndex:10, boxShadow:"0 4px 12px rgba(0,0,0,0.08)", maxHeight:160, overflowY:"auto" }}>
                {sellerResults.slice(0,8).map(s => (
                  <div key={s.id} onClick={() => linkSeller(s.id)}
                    style={{ padding:"7px 10px", fontSize:11, cursor:"pointer", color:C.text }}
                    onMouseEnter={e => e.currentTarget.style.background=C.bgSecondary}
                    onMouseLeave={e => e.currentTarget.style.background="white"}>
                    {sellerName(s)}
                  </div>
                ))}
                {sellerResults.length === 0 && <div style={{ padding:"7px 10px", fontSize:11, color:C.textDim, fontStyle:"italic" }}>No matches</div>}
              </div>
            )}
          </div>
        )}
        {linkedSellerIds.length === 0 && !showSellerSearch && (
          <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No sellers linked</div>
        )}
        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
          {linkedSellerIds.map(id => {
            const s = state.sellers[id];
            if (!s) return null;
            return (
              <div key={id} style={{ display:"inline-flex", alignItems:"center", gap:5,
                background:C.tealLight, color:C.tealText, border:`0.5px solid ${C.tealBorder}`,
                borderRadius:999, padding:"4px 10px", fontSize:11 }}>
                {sellerName(s)}
                <span onClick={() => unlinkSeller(id)} style={{ fontSize:11, color:C.tealText, cursor:"pointer", opacity:0.6, marginLeft:2 }}>✕</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PersonDetail({ person, state, dispatch, onDeleted }) {
  const [tab, setTab] = useState("info");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});

  const personId = person.id;
  useEffect(() => { setTab("info"); setEditing(false); setDraft({}); }, [personId]);

  const startEdit = () => { setDraft({ ...person }); setEditing(true); };
  const cancelEdit = () => { setDraft({}); setEditing(false); };
  const onSave = () => { setEditing(false); setDraft({}); };

  const displayName = `${person.first_name||""} ${person.last_name||""}`.trim() || person.company || person.id;
  const statusC = PEOPLE_STATUS_COLOUR[person.status] || PEOPLE_STATUS_COLOUR.inactive;

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{ padding:"12px 16px 0", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:4 }}>
          <div style={{ fontSize:16, fontWeight:500, color:C.text }}>{displayName}</div>
          {!editing && <Btn onClick={startEdit} style={{ fontSize:10, padding:"3px 12px" }}>Edit</Btn>}
        </div>
        <div style={{ fontSize:10, color:C.textMuted, marginBottom:10, display:"flex", alignItems:"center", gap:8 }}>
          {person.company && <span>{person.company}</span>}
          {person.company && person.role && <span>·</span>}
          {person.role && <span>{person.role}</span>}
          {(person.company || person.role) && <span>·</span>}
          <span style={{ color:statusC.text }}>{PEOPLE_STATUS_LABEL[person.status]||person.status}</span>
        </div>
        <div style={{ display:"flex" }}>
          {["info","contacts","links"].map(t => (
            <span key={t} onClick={() => setTab(t)} style={{
              flex:1, textAlign:"center", padding:"7px 4px", fontSize:11, fontWeight:500,
              cursor:"pointer", userSelect:"none",
              color: tab===t ? C.purple : C.textMuted,
              borderBottom: tab===t ? `2px solid ${C.purple}` : "2px solid transparent",
            }}>{t.charAt(0).toUpperCase()+t.slice(1)}</span>
          ))}
        </div>
      </div>

      {tab==="info"     && <PersonInfoTab person={editing ? {...person,...draft} : person} editing={editing} draft={draft} setDraft={setDraft} onSave={onSave} onCancelEdit={cancelEdit} dispatch={dispatch} onDeleted={onDeleted} />}
      {tab==="contacts" && <PersonContactsTab person={person} dispatch={dispatch} />}
      {tab==="links"    && <PersonLinksTab person={person} state={state} dispatch={dispatch} />}
    </div>
  );
}

function PeopleRegistryScreen({ state, dispatch, searchNav }) {
  const [leftWidth, onDragLeft] = useDraggablePanel(240, 160, 420);
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newCompany, setNewCompany] = useState("");
  const [newRole, setNewRole] = useState("");
  const [newStatus, setNewStatus] = useState("active");
  const [addSaving, setAddSaving] = useState(false);

  useEffect(() => {
    if (searchNav?.selectedId) { setSelectedId(searchNav.selectedId); setShowAddForm(false); }
  }, [searchNav]);

  const people = Object.values(state.people)
    .filter(p => {
      const q = search.toLowerCase();
      if (!q) return true;
      const name = `${p.first_name||""} ${p.last_name||""}`.trim();
      return name.toLowerCase().includes(q)
        || (p.company||"").toLowerCase().includes(q)
        || (p.role||"").toLowerCase().includes(q);
    })
    .sort((a,b) => {
      const na = `${a.first_name||""} ${a.last_name||""}`.trim()||a.company||"";
      const nb = `${b.first_name||""} ${b.last_name||""}`.trim()||b.company||"";
      return na.localeCompare(nb);
    });

  const selected = selectedId ? state.people[selectedId] : null;

  const saveNewPerson = async () => {
    if (!newFirst.trim() && !newLast.trim() && !newCompany.trim()) return;
    setAddSaving(true);
    try {
      const person = {
        id: genId(), first_name: newFirst.trim(), last_name: newLast.trim(),
        company: newCompany.trim(), role: newRole.trim(), status: newStatus,
        passport_number:"", notes:"", contacts:[],
        linked_buyers:[], linked_sellers:[],
        created_at: nowISO(),
      };
      await sb.insert("people", person);
      dispatch({ type:"ADD_PERSON", person });
      setSelectedId(person.id);
      setShowAddForm(false);
      setNewFirst(""); setNewLast(""); setNewCompany(""); setNewRole(""); setNewStatus("active");
    } catch(e) { console.error(e); }
    setAddSaving(false);
  };

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>

      {/* ── LEFT LIST ── */}
      <div style={{ width:leftWidth, borderRight:"none", display:"flex", flexDirection:"column", flexShrink:0 }}>
        <div style={{ padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span style={{ fontSize:13, fontWeight:500, color:C.text }}>People</span>
          <Pill onClick={() => { setShowAddForm(true); setSelectedId(null); }}
            style={{ background:C.purpleLight, color:C.purple, borderColor:C.purpleBorder, fontSize:10, padding:"3px 11px", cursor:"pointer" }}>+ Add</Pill>
        </div>
        <div style={{ padding:"8px 10px", borderBottom:`0.5px solid ${C.border}` }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search people…"
            style={{ width:"100%", border:`0.5px solid ${C.border}`, borderRadius:6, padding:"5px 8px",
              fontSize:11, fontFamily:"inherit", outline:"none", color:C.text }} />
        </div>
        <div style={{ flex:1, overflowY:"auto" }}>
          {people.map(p => {
            const active = selectedId === p.id;
            const name = `${p.first_name||""} ${p.last_name||""}`.trim() || p.company || p.id;
            const statusC = PEOPLE_STATUS_COLOUR[p.status] || PEOPLE_STATUS_COLOUR.inactive;
            return (
              <div key={p.id} onClick={() => { setSelectedId(p.id); setShowAddForm(false); }}
                style={{ padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, cursor:"pointer",
                  background: active ? C.purpleLight : "transparent",
                  borderLeft: active ? `2px solid ${C.purple}` : "2px solid transparent",
                  opacity: p.status === "inactive" ? 0.6 : 1 }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.bgSecondary; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                <div style={{ fontSize:12, fontWeight:500, color:C.text }}>{name}</div>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:3 }}>
                  <Pill style={{ background:statusC.bg, color:statusC.text, borderColor:statusC.border, fontSize:9, padding:"1px 6px" }}>
                    {PEOPLE_STATUS_LABEL[p.status]||p.status}
                  </Pill>
                  {p.role && <span style={{ fontSize:10, color:C.textDim }}>{p.role}</span>}
                </div>
              </div>
            );
          })}
          {people.length === 0 && (
            <div style={{ padding:20, fontSize:11, color:C.textDim, fontStyle:"italic", textAlign:"center" }}>
              {search ? "No people match" : "No people yet"}
            </div>
          )}
        </div>
      </div>

      <DragHandle onMouseDown={onDragLeft} />

      {/* ── RIGHT PANEL ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", borderLeft:`0.5px solid ${C.border}` }}>
        {showAddForm ? (
          <>
            <div style={{ padding:"14px 16px 10px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader }}>
              <div style={{ fontSize:10, color:C.textMuted, textTransform:"uppercase", letterSpacing:"0.05em" }}>New person</div>
              <div style={{ fontSize:13, color:C.textDim, marginTop:4 }}>Fill in the details below</div>
            </div>
            <div style={{ flex:1, padding:"14px 16px", display:"flex", flexDirection:"column", gap:12, overflowY:"auto" }}>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div>
                  <SectionLabel>First name</SectionLabel>
                  <input value={newFirst} onChange={e => setNewFirst(e.target.value)} autoFocus
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div>
                  <SectionLabel>Last name</SectionLabel>
                  <input value={newLast} onChange={e => setNewLast(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div>
                  <SectionLabel>Company</SectionLabel>
                  <input value={newCompany} onChange={e => setNewCompany(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div>
                  <SectionLabel>Role</SectionLabel>
                  <input value={newRole} onChange={e => setNewRole(e.target.value)}
                    style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text }} />
                </div>
                <div style={{ gridColumn:"span 2" }}>
                  <SectionLabel>Status</SectionLabel>
                  <select value={newStatus} onChange={e => setNewStatus(e.target.value)}
                    style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", color:C.text }}>
                    {PEOPLE_STATUSES.map(s => <option key={s} value={s}>{PEOPLE_STATUS_LABEL[s]}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display:"flex", gap:7, justifyContent:"flex-end" }}>
                <Btn onClick={() => setShowAddForm(false)}>Cancel</Btn>
                <Btn style={{ background:C.purple, color:"#fff", borderColor:C.purple }} onClick={saveNewPerson}>{addSaving ? "Saving…" : "Save person"}</Btn>
              </div>
            </div>
          </>
        ) : selected ? (
          <PersonDetail
            key={selected.id}
            person={selected}
            state={state}
            dispatch={dispatch}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8, color:C.textDim }}>
            <div style={{ fontSize:28, opacity:0.2 }}>👤</div>
            <div style={{ fontSize:12, color:C.textDim }}>Select a person or add a new one</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── DOCUMENTS SCREEN ──
const DOC_ICON = { SPA:"📝", LOI:"📋", FCO:"📄", ICPO:"📄", NCNDA:"🔒", KYC:"🪪", "Export Docs":"📦", "Proof of Funds":"💰", Other:"📄" };

function DocumentsScreen({ state, dispatch }) {
  const [filterDeal, setFilterDeal] = useState("");
  const [filterType, setFilterType] = useState("");
  const [viewer, setViewer] = useState(null);
  const [showAddDeal, setShowAddDeal] = useState(false);
  const [showAddTemplate, setShowAddTemplate] = useState(false);

  // Add form fields — shared between deal doc and template
  const [addDisplayName, setAddDisplayName] = useState("");
  const [addFilename, setAddFilename] = useState("");
  const [addLink, setAddLink] = useState("");
  const [addType, setAddType] = useState("SPA");
  const [addDealId, setAddDealId] = useState("");
  const [addDesc, setAddDesc] = useState("");
  const [addSaving, setAddSaving] = useState(false);

  const resetForm = () => {
    setAddDisplayName(""); setAddFilename(""); setAddLink("");
    setAddType("SPA"); setAddDealId(""); setAddDesc("");
  };

  const deals = Object.values(state.deals).filter(d => !d.archived);
  const allDocs = Object.values(state.documents);

  const dealDocs = allDocs.filter(d => !d.is_template &&
    (!filterDeal || d.card_id === filterDeal) &&
    (!filterType || d.type === filterType)
  );
  const templates = allDocs.filter(d => d.is_template &&
    (!filterType || d.type === filterType)
  );

  const dealName = (id) => {
    const d = state.deals[id];
    return d ? (d.deal_name || d.name || id) : id;
  };

  const saveNewDoc = async (isTemplate) => {
    if (!addDisplayName.trim()) return;
    setAddSaving(true);
    try {
      const doc = {
        id: genId(),
        display_name: addDisplayName.trim(),
        original_filename: addFilename.trim(),
        name: addDisplayName.trim(),
        type: addType,
        link: addLink.trim(),
        description: addDesc.trim(),
        card_id: isTemplate ? null : (addDealId || null),
        card_type: isTemplate ? null : (addDealId ? "deal" : null),
        is_template: isTemplate,
        created_at: nowISO(),
      };
      await sb.insert("documents", doc);
      dispatch({ type:"ADD_DOCUMENT", doc });
      resetForm();
      isTemplate ? setShowAddTemplate(false) : setShowAddDeal(false);
    } catch(e) { console.error(e); }
    setAddSaving(false);
  };

  const deleteDoc = async (id) => {
    if (!await confirm(`Delete "${doc.display_name || doc.name || "this document"}"?`)) return;
    try {
      await sb.delete("documents", id);
      dispatch({ type:"DELETE_DOCUMENT", id });
      if (viewer?.id === id) setViewer(null);
    } catch(e) { console.error(e); }
  };

  const updateDoc = async (id, updates) => {
    try {
      await sb.update("documents", id, updates);
      dispatch({ type:"UPDATE_DOCUMENT", id, updates });
    } catch(e) { console.error(e); }
  };

  // ── FULL SCREEN VIEWER ──
  if (viewer) {
    const doc = state.documents[viewer.id] || viewer;
    return (
      <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 16px",
          borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, flexShrink:0 }}>
          <span onClick={() => setViewer(null)}
            style={{ fontSize:11, color:C.blue, cursor:"pointer" }}>← Back to Documents</span>
          <div style={{ fontSize:13, fontWeight:500, color:C.text, flex:1 }}>{doc.display_name || doc.name}</div>
          {doc.original_filename && <span style={{ fontSize:10, color:C.textDim }}>{doc.original_filename}</span>}
          {doc.link && (
            <a href={doc.link} target="_blank" rel="noreferrer"
              style={{ fontSize:11, color:C.blue, textDecoration:"none", cursor:"pointer" }}>Open in Drive ↗</a>
          )}
        </div>
        <div style={{ flex:1, overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center", background:"#f0ede9" }}>
          {doc.link ? (
            <iframe
              src={doc.link.replace("/view","").replace("?usp=sharing","") + "?embedded=true"}
              style={{ width:"100%", height:"100%", border:"none" }}
              title={doc.display_name}
            />
          ) : (
            <div style={{ textAlign:"center", color:C.textDim }}>
              <div style={{ fontSize:40, marginBottom:12 }}>📄</div>
              <div style={{ fontSize:13 }}>No link — nothing to preview</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── ADD FORM ──
  const AddForm = ({ isTemplate, onCancel }) => (
    <div style={{
      margin:"0 16px 12px",
      background: isTemplate ? C.purpleLight : C.blueLight,
      border:`0.5px solid ${isTemplate ? C.purpleBorder : C.blueBorder}`,
      borderRadius:8, padding:14,
    }}>
      <div style={{ fontSize:11, fontWeight:500, color: isTemplate ? C.purple : C.blue, marginBottom:10 }}>
        {isTemplate ? "New template" : "New document"}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
        <div>
          <SectionLabel>Display name</SectionLabel>
          <input
            value={addDisplayName}
            onChange={e => setAddDisplayName(e.target.value)}
            autoFocus
            placeholder="e.g. Orion LC Draft — First Review"
            style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6,
              padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text,
              background:"white", direction:"ltr" }}
          />
        </div>
        <div>
          <SectionLabel>Original filename (optional)</SectionLabel>
          <input
            value={addFilename}
            onChange={e => setAddFilename(e.target.value)}
            placeholder="e.g. SPA_ORR_v1.docx"
            style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6,
              padding:"5px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text,
              background:"white", direction:"ltr" }}
          />
        </div>
        <div>
          <SectionLabel>Link (Google Drive, OneDrive, NAS, or any URL — optional)</SectionLabel>
          <input
            value={addLink}
            onChange={e => setAddLink(e.target.value)}
            placeholder="https://… (any shareable link — optional)"
            style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6,
              padding:"5px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text,
              background:"white", direction:"ltr" }}
          />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}>
          <div>
            <SectionLabel>Type</SectionLabel>
            <select value={addType} onChange={e => setAddType(e.target.value)}
              style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6,
                padding:"5px 8px", fontSize:11, fontFamily:"inherit", color:C.text, background:"white" }}>
              {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {!isTemplate && (
            <div>
              <SectionLabel>Link to deal</SectionLabel>
              <select value={addDealId} onChange={e => setAddDealId(e.target.value)}
                style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6,
                  padding:"5px 8px", fontSize:11, fontFamily:"inherit", color:C.text, background:"white" }}>
                <option value="">— None</option>
                {deals.map(d => <option key={d.id} value={d.id}>{d.deal_name||d.name||d.id}</option>)}
              </select>
            </div>
          )}
        </div>
        <div>
          <SectionLabel>Description (optional)</SectionLabel>
          <textarea
            value={addDesc}
            onChange={e => setAddDesc(e.target.value)}
            rows={2}
            placeholder="Brief description of this document…"
            style={{ width:"100%", border:`0.5px solid ${C.borderMid}`, borderRadius:6,
              padding:"5px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text,
              background:"white", resize:"vertical", display:"block",
              direction:"ltr", textAlign:"left", writingMode:"horizontal-tb" }}
          />
        </div>
        <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn style={{ background: isTemplate ? C.purple : C.blue, color:"#fff",
            borderColor: isTemplate ? C.purple : C.blue }}
            onClick={() => saveNewDoc(isTemplate)}>
            {addSaving ? "Saving…" : `Save ${isTemplate ? "template" : "document"}`}
          </Btn>
        </div>
      </div>
    </div>
  );

  // ── DOC ROW ──
  const DocRow = ({ doc, isTemplate }) => {
    const [hovered, setHovered] = useState(false);
    const [editingDoc, setEditingDoc] = useState(false);
    const [editName, setEditName] = useState(doc.display_name || doc.name || "");
    const [editLink, setEditLink] = useState(doc.link || "");
    const [editDesc, setEditDesc] = useState(doc.description || "");
    const [editType, setEditType] = useState(doc.type || "SPA");
    const [editSaving, setEditSaving] = useState(false);
    const dn = doc.card_id ? dealName(doc.card_id) : null;
    const icon = DOC_ICON[doc.type] || "📄";

    const openEdit = (e) => {
      e.stopPropagation();
      setEditName(doc.display_name || doc.name || "");
      setEditLink(doc.link || "");
      setEditDesc(doc.description || "");
      setEditType(doc.type || "SPA");
      setEditingDoc(true);
    };

    const saveEdit = async (e) => {
      e.stopPropagation();
      if (!editName.trim()) return;
      setEditSaving(true);
      try {
        const updates = { display_name: editName.trim(), name: editName.trim(), link: editLink.trim() || null, description: editDesc.trim(), type: editType };
        await updateDoc(doc.id, updates);
        setEditingDoc(false);
      } catch(err) { console.error(err); }
      setEditSaving(false);
    };

    return (
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ borderBottom:`0.5px solid ${C.border}` }}
      >
        {/* Main row — clickable to open viewer */}
        <div
          onClick={() => !editingDoc && setViewer(doc)}
          style={{ display:"flex", alignItems:"flex-start", gap:12, padding:"10px 16px",
            background: hovered ? C.bgSecondary : "transparent" }}
        >
          {/* Icon — pointer to signal clickability */}
          <div style={{ width:34, height:34, borderRadius:6, flexShrink:0, marginTop:2,
            border:`0.5px solid ${isTemplate ? C.purpleBorder : "#c5d3f8"}`,
            background: isTemplate ? C.purpleLight : "#eef2ff",
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:16,
            cursor: editingDoc ? "default" : "pointer" }}>
            {icon}
          </div>

          {/* Content — pointer on name only */}
          <div style={{ flex:1, minWidth:0, cursor: editingDoc ? "default" : "pointer" }}>
            <div style={{ fontSize:12, fontWeight:500, color:C.text, marginBottom:3 }}>
              {doc.display_name || doc.name}
            </div>
            {doc.original_filename && (
              <div style={{ fontSize:10, color:C.textDim, marginBottom:3 }}>File: {doc.original_filename}</div>
            )}
            {doc.description && (
              <div style={{ fontSize:11, color:C.textMuted, lineHeight:1.5, marginBottom:4 }}>{doc.description}</div>
            )}
            <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"nowrap", overflow:"hidden" }}>
              {dn && <Pill style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:10 }}>🔗 {dn}</Pill>}
              {isTemplate && <Pill style={{ background:C.purpleLight, color:"#5b21b6", borderColor:C.purpleBorder, fontSize:10 }}>Template</Pill>}
              {!dn && !isTemplate && <span style={{ fontSize:10, color:C.textDim, fontStyle:"italic" }}>Not linked to a deal</span>}
              {doc.type && <Pill style={{ background:C.blueLight, color:C.blue, borderColor:C.blueBorder, fontSize:10 }}>{doc.type}</Pill>}
            </div>
          </div>

          {/* Right: date + hover actions */}
          <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6, flexShrink:0 }}>
            <span style={{ fontSize:10, color:C.textDim }}>{doc.created_at ? fmtDate(doc.created_at) : ""}</span>
            <div style={{ display:"flex", gap:5, opacity: hovered && !editingDoc ? 1 : 0, transition:"opacity 0.15s", cursor:"default" }} onClick={e => e.stopPropagation()}>
              <Btn onClick={openEdit} style={{ fontSize:10, padding:"4px 10px", cursor:"pointer" }}>✏ Edit</Btn>
              {doc.link && (
                <a href={doc.link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                  style={{ display:"inline-flex", alignItems:"center", borderRadius:999,
                    padding:"4px 10px", fontSize:10, fontWeight:500, border:`1px solid ${C.border}`,
                    background:"white", color:C.textMuted, textDecoration:"none", cursor:"pointer" }}>
                  Drive ↗
                </a>
              )}
              <Btn variant="red" onClick={e => { e.stopPropagation(); deleteDoc(doc.id); }}
                style={{ fontSize:10, padding:"4px 10px", cursor:"pointer" }}>Delete</Btn>
            </div>
          </div>
        </div>

        {/* Inline edit form */}
        {editingDoc && (
          <div onClick={e => e.stopPropagation()}
            style={{ padding:"12px 16px", background:"#f0fdf4", borderTop:`0.5px solid ${C.greenBorder}` }}>
            <SectionLabel>Edit document</SectionLabel>
            <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
              <div>
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  placeholder="Document name…"
                  style={{ width:"100%", border:`1px solid ${C.tealBorder}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", color:C.text, background:"white" }} />
              </div>
              <div>
                <input value={editLink} onChange={e => setEditLink(e.target.value)}
                  placeholder="Link (Google Drive, OneDrive, NAS, or any URL)"
                  style={{ width:"100%", border:`1px solid ${C.tealBorder}`, borderRadius:6, padding:"5px 8px", fontSize:11, fontFamily:"inherit", outline:"none", color:C.text, background:"white", direction:"ltr" }} />
              </div>
              <div>
                <textarea dir="ltr" value={editDesc} onChange={e => setEditDesc(e.target.value)}
                  placeholder="Description (optional)…" rows={2}
                  style={{ width:"100%", border:`1px solid ${C.tealBorder}`, borderRadius:6, padding:"5px 8px", fontSize:11, fontFamily:"system-ui,sans-serif", outline:"none", color:"#111827", background:"white", resize:"none", display:"block", direction:"ltr", textAlign:"left", writingMode:"horizontal-tb" }} />
              </div>
              <div style={{ display:"flex", gap:6, alignItems:"center", justifyContent:"space-between" }}>
                <select value={editType} onChange={e => setEditType(e.target.value)}
                  style={{ border:`1px solid ${C.tealBorder}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", color:C.text, background:"white" }}>
                  {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
                <div style={{ display:"flex", gap:5 }}>
                  <Btn onClick={e => { e.stopPropagation(); setEditingDoc(false); }}>Cancel</Btn>
                  <Btn variant="solid" onClick={saveEdit}>{editSaving ? "Saving…" : "Save"}</Btn>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const totalCount = dealDocs.length + templates.length;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"10px 16px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, flexShrink:0 }}>
        <span style={{ fontSize:13, fontWeight:500, color:C.text }}>Documents</span>
        <Pill onClick={() => { setShowAddDeal(v => !v); setShowAddTemplate(false); resetForm(); }}
          style={{ background:C.blueLight, color:C.blue, borderColor:C.blueBorder,
            fontSize:10, padding:"3px 12px", cursor:"pointer" }}>+ Add document</Pill>
      </div>

      {/* Filter bar */}
      <div style={{ display:"flex", gap:8, padding:"8px 16px",
        borderBottom:`0.5px solid ${C.border}`, alignItems:"center", flexWrap:"wrap", flexShrink:0 }}>
        <select value={filterDeal} onChange={e => setFilterDeal(e.target.value)}
          style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:999, padding:"3px 12px",
            fontSize:11, color:C.textMuted, background:"white", fontFamily:"inherit" }}>
          <option value="">All deals</option>
          {deals.map(d => <option key={d.id} value={d.id}>{d.deal_name||d.name||d.id}</option>)}
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)}
          style={{ border:`0.5px solid ${C.borderMid}`, borderRadius:999, padding:"3px 12px",
            fontSize:11, color:C.textMuted, background:"white", fontFamily:"inherit" }}>
          <option value="">All types</option>
          {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        {(filterDeal || filterType) && (
          <span onClick={() => { setFilterDeal(""); setFilterType(""); }}
            style={{ fontSize:10, color:C.textMuted, cursor:"pointer", textDecoration:"underline" }}>Clear</span>
        )}
        <span style={{ fontSize:11, color:C.textDim, marginLeft:"auto" }}>
          {totalCount} document{totalCount !== 1 ? "s" : ""}
        </span>
      </div>

      {/* List */}
      <div style={{ flex:1, overflowY:"auto" }}>

        {/* Deal documents section */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          padding:"8px 16px 5px", background:C.bgSecondary, borderBottom:`0.5px solid ${C.border}`,
          position:"sticky", top:0, zIndex:1 }}>
          <span style={{ fontSize:9, fontWeight:500, textTransform:"uppercase",
            letterSpacing:"0.07em", color:C.textDim, display:"flex", alignItems:"center", gap:5 }}>
            📄 Deal documents
            <Pill style={{ background:"white", color:C.textMuted, borderColor:C.border, fontSize:9, padding:"1px 6px" }}>{dealDocs.length}</Pill>
          </span>
          <span onClick={() => { setShowAddDeal(v => !v); setShowAddTemplate(false); resetForm(); }}
            style={{ fontSize:10, color:C.blue, cursor:"pointer" }}>+ Add</span>
        </div>
        {showAddDeal && <AddForm isTemplate={false} onCancel={() => { setShowAddDeal(false); resetForm(); }} />}
        {dealDocs.length === 0 && !showAddDeal && (
          <div style={{ padding:"12px 16px", fontSize:11, color:C.textDim, fontStyle:"italic" }}>No deal documents yet</div>
        )}
        {[...dealDocs].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)).map(d => <DocRow key={d.id} doc={d} isTemplate={false} />)}

        {/* Templates section */}
        <div style={{ borderTop:`2px solid ${C.border}`, marginTop:4 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
            padding:"8px 16px 5px", background:C.bgSecondary, borderBottom:`0.5px solid ${C.border}`,
            position:"sticky", top:0, zIndex:1 }}>
            <span style={{ fontSize:9, fontWeight:500, textTransform:"uppercase",
              letterSpacing:"0.07em", color:C.textDim, display:"flex", alignItems:"center", gap:5 }}>
              📋 Templates
              <Pill style={{ background:"white", color:C.textMuted, borderColor:C.border, fontSize:9, padding:"1px 6px" }}>{templates.length}</Pill>
            </span>
            <span onClick={() => { setShowAddTemplate(v => !v); setShowAddDeal(false); resetForm(); }}
              style={{ fontSize:10, color:C.blue, cursor:"pointer" }}>+ Add template</span>
          </div>
          {showAddTemplate && <AddForm isTemplate={true} onCancel={() => { setShowAddTemplate(false); resetForm(); }} />}
          {templates.length === 0 && !showAddTemplate && (
            <div style={{ padding:"12px 16px", fontSize:11, color:C.textDim, fontStyle:"italic" }}>No templates yet</div>
          )}
          {[...templates].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)).map(d => <DocRow key={d.id} doc={d} isTemplate={true} />)}
        </div>
      </div>
    </div>
  );
}


// ── JOURNAL SCREEN ──

// Simple Markdown renderer — no dependencies
function renderMarkdown(md) {
  if (!md) return "";
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^---+$/.test(line.trim())) {
      out.push(`<hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0"/>`);
    } else if (/^### (.+)/.test(line)) {
      out.push(`<h3 style="font-size:13px;font-weight:600;color:#111827;margin:10px 0 4px">${inline(line.replace(/^### /,""))}</h3>`);
    } else if (/^## (.+)/.test(line)) {
      out.push(`<h2 style="font-size:14px;font-weight:600;color:#111827;margin:12px 0 5px">${inline(line.replace(/^## /,""))}</h2>`);
    } else if (/^# (.+)/.test(line)) {
      out.push(`<h1 style="font-size:16px;font-weight:600;color:#111827;margin:14px 0 6px">${inline(line.replace(/^# /,""))}</h1>`);
    } else if (/^> (.+)/.test(line)) {
      out.push(`<div style="border-left:3px solid #185fa5;padding:5px 10px;margin:8px 0;background:#e6f1fb;border-radius:0 5px 5px 0"><span style="font-size:12px;color:#185fa5;font-style:italic">${inline(line.replace(/^> /,""))}</span></div>`);
    } else if (/^[-*] (.+)/.test(line)) {
      // Collect consecutive list items
      const items = [];
      while (i < lines.length && /^[-*] (.+)/.test(lines[i])) {
        items.push(`<li style="font-size:12px;color:#111827;line-height:1.7">${inline(lines[i].replace(/^[-*] /,""))}</li>`);
        i++;
      }
      out.push(`<ul style="margin:4px 0 4px 18px">${items.join("")}</ul>`);
      continue;
    } else if (line.trim() === "") {
      out.push(`<div style="height:6px"></div>`);
    } else {
      out.push(`<p style="font-size:12px;color:#111827;line-height:1.7;margin:0 0 4px">${inline(line)}</p>`);
    }
    i++;
  }
  return out.join("");
}

function inline(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, `<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:11px">$1</code>`);
}

function MarkdownView({ text }) {
  return (
    <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
  );
}

function JournalScreen({ state, dispatch }) {
  const today = todayStr();
  const [reflectionWidth, onDragReflection] = useDraggablePanel(260, 180, 480);

  const threadsByDate = {};
  Object.values(state.threads).forEach(e => {
    if (!e.created_at) return;
    const d = e.created_at.split("T")[0];
    if (!threadsByDate[d]) threadsByDate[d] = [];
    threadsByDate[d].push(e);
  });

  const journalDates = new Set(Object.keys(state.journal));
  const threadDates  = new Set(Object.keys(threadsByDate));
  const allDates = [...new Set([...journalDates, ...threadDates])].sort((a,b) => b.localeCompare(a));

  const [selectedDate, setSelectedDate] = useState(() => {
    if (journalDates.has(today) || threadDates.has(today)) return today;
    return allDates[0] || today;
  });

  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState("");
  const textareaRef = useRef(null);

  // Floating toolbar state
  const [toolbar, setToolbar] = useState(null); // { top, left } or null
  const reflectionPanelRef = useRef(null);

  const [journalSearch, setJournalSearch] = useState("");
  const journalSearchWords = journalSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchesSearch = (e) => journalSearchWords.length === 0 ||
    journalSearchWords.every(w => (e.text || "").toLowerCase().includes(w));

  const journalEntry = state.journal[selectedDate];
  // While a search is active, only the entries that actually match are
  // shown — not the whole day's activity with the match buried inside it.
  // Showing the full day made every group look like part of the result,
  // when only one note in one group actually matched.
  const dayThreads = (threadsByDate[selectedDate] || []).filter(matchesSearch);

  const dealGroups = {};
  dayThreads.forEach(e => {
    const key = e.card_id || "__admin__";
    if (!dealGroups[key]) dealGroups[key] = [];
    dealGroups[key].push(e);
  });

  const [collapsed, setCollapsed] = useState({});
  const toggleCollapse = (key) => setCollapsed(c => ({ ...c, [key]: !c[key] }));

  // Month collapse state — current month open by default, others closed
  const currentMonthKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${d.toLocaleDateString("en-GB", { month:"long" })}`;
  };
  const [collapsedMonths, setCollapsedMonths] = useState({});
  const toggleMonth = (key) => setCollapsedMonths(c => ({ ...c, [key]: !c[key] }));
  const isMonthCollapsed = (year, month) => {
    const key = `${year}-${month}`;
    if (key in collapsedMonths) return collapsedMonths[key];
    return key !== currentMonthKey(); // default: current month open, others closed
  };

  const startEdit = () => { setDraftText(journalEntry?.text || ""); setEditing(true); setToolbar(null); };
  const cancelEdit = () => { setEditing(false); setToolbar(null); };

  const saveReflection = async () => {
    const text = draftText.trim();
    try {
      await sb.upsert("journal", { date: selectedDate, text, updated_at: nowISO() }, "date");
      dispatch({ type:"SAVE_JOURNAL", date:selectedDate, text });
      setEditing(false); setToolbar(null);
    } catch(e) { console.error(e); }
  };

  // Floating toolbar: show when user has a selection in the textarea
  const handleTextareaSelect = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd } = ta;
    if (selectionStart === selectionEnd) { setToolbar(null); return; }
    // Position toolbar above the textarea using fixed coords relative to panel
    const rect = ta.getBoundingClientRect();
    const panelRect = reflectionPanelRef.current?.getBoundingClientRect();
    if (!panelRect) return;
    setToolbar({ top: rect.top - panelRect.top - 40, left: 0 });
  };

  const applyFormat = (type) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const sel = value.slice(s, e);
    const before = value.slice(0, s);
    const after = value.slice(e);
    let replacement = sel;
    let cursorOffset = 0;

    if (type === "bold")   { replacement = `**${sel}**`; cursorOffset = 2; }
    if (type === "italic") { replacement = `*${sel}*`;   cursorOffset = 1; }
    if (type === "h1")     { replacement = `# ${sel}`;   cursorOffset = 2; }
    if (type === "h2")     { replacement = `## ${sel}`;  cursorOffset = 3; }
    if (type === "quote")  { replacement = `> ${sel}`;   cursorOffset = 2; }
    if (type === "list")   { replacement = `- ${sel}`;   cursorOffset = 2; }

    const newText = before + replacement + after;
    setDraftText(newText);
    setToolbar(null);

    // Restore cursor after React re-render
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(s + cursorOffset, s + replacement.length - (type === "bold" ? 2 : type === "italic" ? 1 : 0));
    }, 0);
  };

  const fmtNavDate = (iso) => {
    const d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-GB", { weekday:"short", day:"numeric", month:"short" });
  };

  const fmtFullDate = (iso) => {
    if (iso === today) return { label: new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" }), sub:"Today" };
    const d = new Date(iso + "T12:00:00");
    return { label: d.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" }), sub:null };
  };

  const navGroups = [];
  allDates.forEach(d => {
    const dt = new Date(d + "T12:00:00");
    const year = dt.getFullYear().toString();
    const month = dt.toLocaleDateString("en-GB", { month:"long" });
    const last = navGroups[navGroups.length - 1];
    if (!last || last.year !== year || last.month !== month) {
      navGroups.push({ year, month, dates:[] });
    }
    navGroups[navGroups.length - 1].dates.push(d);
  });

  // Resolves a group's display name by actually checking what kind of
  // record card_id points at, instead of assuming every card_id is a deal.
  // Progress notes added directly on a task carry card_type:"task" and
  // card_id:task.id — looking those up in state.deals always failed
  // silently and fell back to printing the raw id, which is what showed
  // up as "5zeaqj5xs" etc. instead of a readable name.
  const groupLabel = (id, entries) => {
    const cardType = entries?.[0]?.card_type;
    if (cardType === "task") {
      const t = state.tasks[id];
      return t ? `Task · ${t.title || "Untitled task"}` : `Task (deleted)`;
    }
    const d = state.deals[id];
    if (d) return d.deal_name || d.name || "Unnamed deal";
    // card_type missing/unknown and no matching deal — try task as a
    // fallback before giving up, since older entries may predate
    // card_type being recorded consistently.
    const t = state.tasks[id];
    if (t) return `Task · ${t.title || "Untitled task"}`;
    return "Unknown record";
  };
  const dealName = (id) => { const d = state.deals[id]; return d ? (d.deal_name || d.name || id) : id; };
  const dealStateColour = (id) => {
    const d = state.deals[id];
    if (!d) return "#9ca3af";
    return STATE_COLOURS[d.state || d.status || "potential"]?.text || "#9ca3af";
  };

  const dateHeader = fmtFullDate(selectedDate);
  const dealCount = Object.keys(dealGroups).filter(k => k !== "__admin__").length;
  const adminCount = (dealGroups["__admin__"] || []).length;

  // Which dates have at least one thread entry matching all search words.
  // Word-by-word AND, same convention as the board search, so a search for
  // "andrew sick" matches an entry containing both words anywhere in its
  // text, regardless of order or exact phrasing.
  const matchingDates = journalSearchWords.length === 0 ? null : new Set(
    allDates.filter(d => (threadsByDate[d] || []).some(matchesSearch))
  );

  const visibleNavGroups = matchingDates === null ? navGroups :
    navGroups.map(g => ({ ...g, dates: g.dates.filter(d => matchingDates.has(d)) }))
             .filter(g => g.dates.length > 0);

  // While a search is active, auto-select the first matching date so
  // typing immediately surfaces a result instead of leaving the panel
  // showing whatever day happened to be selected before the search began.
  useEffect(() => {
    if (matchingDates !== null && matchingDates.size > 0 && !matchingDates.has(selectedDate)) {
      setSelectedDate([...matchingDates][0]);
    }
  }, [journalSearch]);

  const FMT_BTNS = [
    { type:"h1",     label:"H1" },
    { type:"h2",     label:"H2" },
    { type:"bold",   label:"B",  style:{ fontWeight:700 } },
    { type:"italic", label:"I",  style:{ fontStyle:"italic" } },
    { type:"quote",  label:"❝" },
    { type:"list",   label:"—" },
  ];

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>

      {/* ── LEFT NAV ── */}
      <div style={{ width:200, borderRight:`0.5px solid ${C.border}`, background:C.panelHeader, display:"flex", flexDirection:"column", flexShrink:0 }}>
        <div style={{ padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span style={{ fontSize:13, fontWeight:500, color:C.text }}>Journal</span>
          <Pill onClick={() => { setSelectedDate(today); startEdit(); }}
            style={{ background:C.blueLight, color:C.blue, borderColor:C.blueBorder, fontSize:10, padding:"3px 10px", cursor:"pointer" }}>+ Reflect</Pill>
        </div>
        <div style={{ padding:"8px 14px", borderBottom:`0.5px solid ${C.border}` }}>
          <input
            value={journalSearch}
            onChange={e => setJournalSearch(e.target.value)}
            placeholder="Search journal…"
            style={{
              width:"100%", border:`0.5px solid ${journalSearch ? C.tealBorder : C.borderMid}`,
              borderRadius:999, padding:"4px 10px", fontSize:11, fontFamily:"inherit",
              outline:"none", color:C.text, background:C.bg, boxSizing:"border-box"
            }}
          />
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"6px 0" }}>
          {allDates.length === 0 && (
            <div style={{ padding:"14px", fontSize:11, color:C.textDim, fontStyle:"italic" }}>No activity yet</div>
          )}
          {allDates.length > 0 && journalSearchWords.length > 0 && visibleNavGroups.length === 0 && (
            <div style={{ padding:"14px", fontSize:11, color:C.textDim, fontStyle:"italic" }}>No matches for "{journalSearch}"</div>
          )}
          {visibleNavGroups.map((g, gi) => {
            const monthCollapsed = journalSearchWords.length > 0 ? false : isMonthCollapsed(g.year, g.month);
            const monthKey = `${g.year}-${g.month}`;
            return (
              <div key={gi}>
                {(gi === 0 || visibleNavGroups[gi-1].year !== g.year) && (
                  <div style={{ fontSize:9, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.07em", color:C.textDim, padding:"8px 14px 2px" }}>{g.year}</div>
                )}
                {/* Month header — clickable to collapse */}
                <div onClick={() => toggleMonth(monthKey)}
                  style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"5px 14px 4px", cursor:"pointer", userSelect:"none" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(0,0,0,0.04)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontSize:11, fontWeight:600, color:C.text }}>{g.month}</span>
                  <span style={{ fontSize:9, color:C.textDim }}>{monthCollapsed ? "▶" : "▼"}</span>
                </div>
                {/* Dates — hidden when month collapsed */}
                {!monthCollapsed && g.dates.map(d => {
                  const isSelected = d === selectedDate;
                  const hasReflection = journalDates.has(d);
                  // While searching, show how many entries on this day
                  // actually matched — not the day's unfiltered total —
                  // so it's clear at a glance which days have real hits
                  // and that more than one day can match simultaneously.
                  const count = journalSearchWords.length > 0
                    ? (threadsByDate[d] || []).filter(matchesSearch).length
                    : (threadsByDate[d] || []).length;
                  const isToday_ = d === today;
                  return (
                    <div key={d} onClick={() => { setSelectedDate(d); setEditing(false); }}
                      style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 14px 4px 20px", cursor:"pointer",
                        background: isSelected ? C.blueLight : "transparent",
                        color: isSelected ? C.blue : C.textMuted, fontSize:11, fontWeight: isSelected ? 500 : 400 }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "rgba(0,0,0,0.04)"; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
                      <div style={{ width:6, height:6, borderRadius:"50%", flexShrink:0,
                        background: isToday_ ? C.blue : hasReflection ? C.teal : C.textDim }} />
                      <span style={{ flex:1 }}>{fmtNavDate(d)}</span>
                      {count > 0 && (
                        <span style={{ fontSize:9, background: isSelected ? "white" : C.bgSecondary,
                          borderRadius:999, padding:"1px 5px",
                          border:`0.5px solid ${isSelected ? C.blueBorder : C.border}`,
                          color: isSelected ? C.blue : C.textDim }}>
                          {count}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── CENTRE: DAILY ACTIVITY ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", borderRight:`0.5px solid ${C.border}`, overflow:"hidden" }}>
        <div style={{ padding:"12px 16px", borderBottom:`0.5px solid ${C.border}`, flexShrink:0 }}>
          <div style={{ fontSize:16, fontWeight:500, color:C.text }}>{dateHeader.label}</div>
          <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>
            {dateHeader.sub && <span>{dateHeader.sub} · </span>}
            {dealCount > 0 ? `${dealCount} deal${dealCount !== 1 ? "s" : ""} with activity` : "No deal activity"}
            {adminCount > 0 && ` · ${adminCount} admin note${adminCount !== 1 ? "s" : ""}`}
          </div>
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"12px 16px", display:"flex", flexDirection:"column", gap:0 }}>
          {dayThreads.length === 0 && (
            <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No activity logged for this day</div>
          )}
          {Object.entries(dealGroups).filter(([k]) => k !== "__admin__").map(([dealId, groupEntries]) => {
            const isCollapsed = collapsed[dealId];
            const sorted = [...groupEntries].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
            return (
              <div key={dealId} style={{ marginBottom:12 }}>
                {/* Deal group header */}
                <div onClick={() => toggleCollapse(dealId)}
                  style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"6px 10px", background:C.bgSecondary, borderRadius:8,
                    border:`0.5px solid ${C.border}`, cursor:"pointer", marginBottom: isCollapsed ? 0 : 8 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <div style={{ width:7, height:7, borderRadius:"50%", background:dealStateColour(dealId), flexShrink:0 }} />
                    <span style={{ fontSize:11, fontWeight:600, color:C.text }}>{groupLabel(dealId, groupEntries)}</span>
                    <Pill style={{ background:"white", color:C.textMuted, borderColor:C.border, fontSize:9, padding:"1px 6px" }}>
                      {groupEntries.length} activit{groupEntries.length === 1 ? "y" : "ies"}
                    </Pill>
                  </div>
                  <span style={{ fontSize:11, color:C.textDim }}>{isCollapsed ? "▶" : "▼"}</span>
                </div>
                {/* Entries with timeline */}
                {!isCollapsed && (
                  <div style={{ paddingLeft:8 }}>
                    {sorted.map((e, idx) => (
                      <ActivityEntry
                        key={e.id}
                        entry={e}
                        onDelete={() => {}}
                        dispatch={dispatch}
                        readOnly={true}
                        isLast={idx === sorted.length - 1}
                        searchWords={journalSearchWords}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {dealGroups["__admin__"] && (() => {
            const entries = dealGroups["__admin__"];
            const isCollapsed = collapsed["__admin__"];
            const sorted = [...entries].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
            return (
              <div style={{ marginBottom:12, opacity:0.8 }}>
                <div onClick={() => toggleCollapse("__admin__")}
                  style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                    padding:"6px 10px", background:C.bgSecondary, borderRadius:8,
                    border:`0.5px solid ${C.border}`, cursor:"pointer", marginBottom: isCollapsed ? 0 : 8 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <div style={{ width:7, height:7, borderRadius:"50%", background:C.textDim, flexShrink:0 }} />
                    <span style={{ fontSize:11, fontWeight:600, color:C.textMuted }}>Admin</span>
                    <Pill style={{ background:"white", color:C.textDim, borderColor:C.border, fontSize:9, padding:"1px 6px" }}>
                      {entries.length} note{entries.length !== 1 ? "s" : ""}
                    </Pill>
                  </div>
                  <span style={{ fontSize:11, color:C.textDim }}>{isCollapsed ? "▶" : "▼"}</span>
                </div>
                {!isCollapsed && (
                  <div style={{ paddingLeft:8 }}>
                    {sorted.map((e, idx) => (
                      <ActivityEntry
                        key={e.id}
                        entry={e}
                        onDelete={() => {}}
                        dispatch={dispatch}
                        readOnly={true}
                        isLast={idx === sorted.length - 1}
                        searchWords={journalSearchWords}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      <DragHandle onMouseDown={onDragReflection} />

      {/* ── RIGHT: REFLECTION ── */}
      <div ref={reflectionPanelRef} style={{ width:reflectionWidth, flexShrink:0, display:"flex", flexDirection:"column", overflow:"hidden", position:"relative", borderLeft:`1px solid ${C.border}` }}>
        <div style={{ padding:"12px 14px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, background:C.panelHeader }}>
          <span style={{ fontSize:12, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", color:C.text }}>Reflection</span>
          {!editing && (
            <Btn variant={journalEntry ? "teal" : "solid"} onClick={startEdit} style={{ fontSize:11, padding:"5px 16px" }}>
              {journalEntry ? "✏ Edit" : "✍ Write"}
            </Btn>
          )}
        </div>

        {/* Floating format toolbar — appears on text selection */}
        {editing && toolbar && (
          <div style={{
            position:"absolute", top: Math.max(56, toolbar.top), left:10, right:10, zIndex:50,
            background:"white", border:`1px solid ${C.borderMid}`, borderRadius:8,
            boxShadow:"0 4px 16px rgba(0,0,0,0.14)",
            display:"flex", alignItems:"center", gap:2, padding:"5px 8px",
          }}>
            {FMT_BTNS.map(btn => (
              <span key={btn.type}
                onMouseDown={e => { e.preventDefault(); applyFormat(btn.type); }}
                style={{ padding:"4px 9px", borderRadius:6, fontSize:12, fontWeight:600, cursor:"pointer",
                  color:C.text, userSelect:"none", ...(btn.style||{}),
                  background:"transparent" }}
                onMouseEnter={e => e.currentTarget.style.background = C.blueLight}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                {btn.label}
              </span>
            ))}
            <span style={{ fontSize:10, color:C.textDim, marginLeft:4, paddingLeft:6, borderLeft:`1px solid ${C.border}` }}>
              Format selection
            </span>
          </div>
        )}

        {/* Content area — scrollable */}
        <div style={{ flex:1, overflowY:"auto", padding:14 }}>
          {editing ? (
            <textarea
              ref={textareaRef}
              value={draftText}
              onChange={e => setDraftText(e.target.value)}
              onSelect={handleTextareaSelect}
              onMouseUp={handleTextareaSelect}
              onKeyUp={handleTextareaSelect}
              placeholder={"# End of day\n\nWrite your reflection here…"}
              style={{ width:"100%", height:"100%", minHeight:200,
                border:`2px solid ${C.teal}`, borderRadius:8,
                padding:"10px 12px", fontSize:12, fontFamily:"inherit", resize:"none", outline:"none",
                color:C.text, lineHeight:1.7, background:"white",
                boxShadow:"0 0 0 3px rgba(42,125,110,0.1)" }}
            />
          ) : journalEntry?.text ? (
            <div onClick={startEdit} style={{ cursor:"text", minHeight:100 }}>
              <MarkdownView text={journalEntry.text} />
              <div style={{ fontSize:10, color:C.textDim, marginTop:12, display:"flex", alignItems:"center", gap:4 }}>
                <span>✏</span> Click to edit
              </div>
            </div>
          ) : (
            <div onClick={startEdit} style={{ cursor:"text", padding:"20px 0" }}>
              <div style={{ fontSize:12, color:C.textDim, lineHeight:1.7, fontStyle:"italic", marginBottom:10 }}>
                No reflection for {selectedDate === today ? "today" : fmtNavDate(selectedDate)}.
              </div>
              <Btn variant="solid" onClick={startEdit}>✍ Write a reflection</Btn>
            </div>
          )}
        </div>

        {/* Pinned footer */}
        {editing && (
          <div style={{ borderTop:`1px solid ${C.border}`, padding:"10px 14px", background:C.bgSecondary, flexShrink:0 }}>
            <div style={{ fontSize:10, color:C.textMuted, marginBottom:8 }}>Select text to format · --- for divider</div>
            <div style={{ display:"flex", gap:8 }}>
              <Btn onClick={cancelEdit}>Cancel</Btn>
              <Btn variant="solid" onClick={saveReflection}>Save reflection</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── CALENDAR SCREEN ──
function CalendarScreen({ state, dispatch, onNavigate }) {
  const today = todayStr();
  const todayDate = new Date(today + "T12:00:00");
  const [gridWidth, onDragGrid] = useDraggablePanel(380, 260, 560);

  const [viewYear,  setViewYear]  = useState(todayDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(todayDate.getMonth()); // 0-indexed
  const [selectedDay, setSelectedDay] = useState(today);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerYear, setPickerYear] = useState(todayDate.getFullYear());
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState("normal");
  const [addSaving, setAddSaving] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState(null);

  // Pre-compute signals for each date string in current month
  const tasksArr   = Object.values(state.tasks).filter(t => t.status !== "archived" && t.status !== "completed");
  const threadsArr = Object.values(state.threads);
  const journalMap = state.journal;

  const signalsByDate = {};
  const ensure = (d) => { if (!signalsByDate[d]) signalsByDate[d] = { tasks:0, overdue:0, activity:0, reflect:false }; };

  tasksArr.forEach(t => {
    if (!t.due_date) return;
    ensure(t.due_date);
    if (isOverdue(t.due_date)) signalsByDate[t.due_date].overdue++;
    else signalsByDate[t.due_date].tasks++;
  });
  threadsArr.forEach(e => {
    if (!e.created_at) return;
    const d = e.created_at.split("T")[0];
    ensure(d);
    signalsByDate[d].activity++;
  });
  Object.keys(journalMap).forEach(d => {
    ensure(d);
    signalsByDate[d].reflect = true;
  });

  // Build calendar grid
  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const daysInMonth  = new Date(viewYear, viewMonth + 1, 0).getDate();
  const startDow     = firstOfMonth.getDay(); // 0=Sun

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${viewYear}-${String(viewMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    cells.push({ day:d, iso });
  }

  const prevMonth = () => { if (viewMonth === 0) { setViewYear(y => y-1); setViewMonth(11); } else setViewMonth(m => m-1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewYear(y => y+1); setViewMonth(0); } else setViewMonth(m => m+1); };
  const goToday   = () => { setViewYear(todayDate.getFullYear()); setViewMonth(todayDate.getMonth()); setSelectedDay(today); };

  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Day detail data
  const dayTasks   = Object.values(state.tasks).filter(t => t.due_date === selectedDay && t.status !== "archived" && t.status !== "completed");
  const dayThreads = Object.values(state.threads)
    .filter(e => {
      if (!e.created_at?.startsWith(selectedDay)) return false;
      if (e.card_type === "task") return false;
      return true;
    })
    .sort((a,b) => new Date(a.created_at)-new Date(b.created_at));

  // DEBUG — remove after diagnosis
  const allDayEntries = Object.values(state.threads).filter(e => e.created_at?.startsWith(selectedDay));
  if (allDayEntries.length > 0) {
    console.log("All entries for", selectedDay, ":", allDayEntries.map(e => ({ id:e.id, card_type:e.card_type, channel:e.channel, card_id:e.card_id })));
    console.log("Showing after filter:", dayThreads.length, "of", allDayEntries.length);
  }
  const dayReflect = journalMap[selectedDay];

  const dealName = (id) => { const d = state.deals[id]; return d ? (d.deal_name||d.name||id) : null; };

  const saveNewTask = async () => {
    if (!newTaskTitle.trim()) return;
    setAddSaving(true);
    try {
      const task = {
        id:genId(), title:newTaskTitle.trim(), description:"", due_date:selectedDay,
        priority:newTaskPriority, status:"not_started", card_id:null, card_type:null,
        subtasks:[], created_at:nowISO(),
      };
      await sb.insert("tasks", task);
      dispatch({ type:"ADD_TASK", task });
      setNewTaskTitle(""); setNewTaskPriority("normal"); setShowAddTask(false);
    } catch(e) { console.error(e); }
    setAddSaving(false);
  };

  const fmtSelectedDay = () => {
    const d = new Date(selectedDay + "T12:00:00");
    const label = d.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
    const parts = [];
    if (selectedDay === today) parts.push("Today");
    const tc = dayTasks.length; const ac = dayThreads.length;
    if (tc > 0) parts.push(`${tc} task${tc!==1?"s":""}`);
    if (ac > 0) parts.push(`${ac} activit${ac!==1?"ies":"y"}`);
    return { label, sub: parts.join(" · ") };
  };

  const { label: dayLabel, sub: daySub } = fmtSelectedDay();

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden", position:"relative" }}>

      {/* ── MONTH PICKER OVERLAY ── */}
      {showPicker && (
        <div onClick={() => setShowPicker(false)}
          style={{ position:"absolute", inset:0, zIndex:40, background:"rgba(0,0,0,0.15)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position:"absolute", top:50, left:20, background:"white", borderRadius:10,
              border:`0.5px solid ${C.border}`, boxShadow:"0 8px 24px rgba(0,0,0,0.14)",
              padding:"14px 16px", width:240, zIndex:41 }}>
            {/* Year nav */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
              <span onClick={() => setPickerYear(y => y-1)}
                style={{ width:26, height:26, borderRadius:6, border:`0.5px solid ${C.borderMid}`, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:13 }}>‹</span>
              <span style={{ fontSize:13, fontWeight:600, color:C.text }}>{pickerYear}</span>
              <span onClick={() => setPickerYear(y => y+1)}
                style={{ width:26, height:26, borderRadius:6, border:`0.5px solid ${C.borderMid}`, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:13 }}>›</span>
            </div>
            {/* 12 month buttons */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:5 }}>
              {MONTH_SHORT.map((m, i) => {
                const active = i === viewMonth && pickerYear === viewYear;
                return (
                  <span key={i} onClick={() => { setViewYear(pickerYear); setViewMonth(i); setShowPicker(false); }}
                    style={{ padding:"5px 2px", textAlign:"center", borderRadius:6, fontSize:11, cursor:"pointer", fontWeight:500,
                      background: active ? C.teal : "transparent", color: active ? "white" : C.textMuted,
                      border: active ? "none" : `0.5px solid transparent` }}
                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = C.bgSecondary; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                    {m}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── LEFT: GRID ── */}
      <div style={{ width:gridWidth, flexShrink:0, borderRight:"none", display:"flex", flexDirection:"column", overflow:"hidden" }}>
        {/* Topbar */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 14px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span onClick={prevMonth}
              style={{ width:26, height:26, borderRadius:6, border:`0.5px solid ${C.borderMid}`, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:13, background:"white" }}>‹</span>
            <span onClick={() => { setPickerYear(viewYear); setShowPicker(v => !v); }}
              style={{ display:"flex", alignItems:"center", gap:5, padding:"3px 10px", borderRadius:999, border:`0.5px solid ${C.borderMid}`, background:"white", cursor:"pointer", fontSize:13, fontWeight:500, color:C.text }}>
              {MONTH_NAMES[viewMonth]} {viewYear} <span style={{ fontSize:11, color:C.textDim }}>▾</span>
            </span>
            <span onClick={nextMonth}
              style={{ width:26, height:26, borderRadius:6, border:`0.5px solid ${C.borderMid}`, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:13, background:"white" }}>›</span>
            <span onClick={goToday}
              style={{ fontSize:10, fontWeight:500, border:`0.5px solid ${C.borderMid}`, borderRadius:999, padding:"3px 11px", background:"white", cursor:"pointer", color:C.textMuted }}>Today</span>
          </div>
        </div>

        {/* Day-of-week headers */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", padding:"4px 8px 0", flexShrink:0 }}>
          {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => (
            <div key={d} style={{ textAlign:"center", fontSize:9, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:C.textDim, padding:"4px 0" }}>{d}</div>
          ))}
        </div>

        {/* Grid cells */}
        <div style={{ flex:1, display:"grid", gridTemplateColumns:"repeat(7,1fr)", gridAutoRows:"1fr", gap:1, padding:"2px 6px 4px", overflow:"hidden" }}>
          {cells.map((cell, idx) => {
            if (!cell) return <div key={idx} />;
            const { day, iso } = cell;
            const sig = signalsByDate[iso] || {};
            const isToday_ = iso === today;
            const isSelected = iso === selectedDay;
            const isOtherMonth = false;
            const hasOverdue = sig.overdue > 0;
            const taskCount = (sig.tasks||0) + (sig.overdue||0);

            return (
              <div key={iso} onClick={() => setSelectedDay(iso)}
                style={{ padding:"3px 4px", borderRadius:6, cursor:"pointer", position:"relative",
                  border: isSelected ? `0.5px solid ${C.teal}` : "0.5px solid transparent",
                  background: isSelected ? C.tealLight : "transparent" }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = C.bgSecondary; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}>
                {/* Day number */}
                {isToday_ ? (
                  <div style={{ width:20, height:20, borderRadius:"50%", background:C.blue, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:2 }}>
                    <span style={{ fontSize:11, fontWeight:500, color:"white" }}>{day}</span>
                  </div>
                ) : (
                  <div style={{ fontSize:11, fontWeight:500, color:C.text, marginBottom:2 }}>{day}</div>
                )}
                {/* Signal pills */}
                {hasOverdue && (
                  <div style={{ display:"inline-flex", alignItems:"center", borderRadius:999, padding:"1px 4px", fontSize:8, fontWeight:500, border:`0.5px solid ${C.redBorder}`, background:C.redLight, color:C.red, marginBottom:1 }}>overdue</div>
                )}
                {sig.tasks > 0 && (
                  <div style={{ display:"inline-flex", alignItems:"center", borderRadius:999, padding:"1px 4px", fontSize:8, fontWeight:500, border:`0.5px solid ${C.blueBorder}`, background:C.blueLight, color:C.blue, marginBottom:1 }}>
                    {taskCount > 1 ? `${taskCount} tasks` : "1 task"}
                  </div>
                )}
                {sig.activity > 0 && (
                  <div style={{ display:"block", borderRadius:999, padding:"1px 4px", fontSize:8, fontWeight:500, border:`0.5px solid ${C.tealBorder}`, background:C.tealLight, color:C.tealText, marginBottom:1 }}>active</div>
                )}
                {sig.reflect && (
                  <div style={{ display:"block", borderRadius:999, padding:"1px 4px", fontSize:8, fontWeight:500, border:`0.5px solid ${C.blueBorder}`, background:C.blueLight, color:C.blue }}>reflect</div>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div style={{ display:"flex", gap:10, padding:"6px 12px", borderTop:`0.5px solid ${C.border}`, flexWrap:"wrap", flexShrink:0 }}>
          {[
            { label:"task",    bg:C.blueLight,  text:C.blue,    border:C.blueBorder,  desc:"Due" },
            { label:"overdue", bg:C.redLight,   text:C.red,     border:C.redBorder,   desc:"Overdue" },
            { label:"active",  bg:C.tealLight,  text:C.tealText,border:C.tealBorder,  desc:"Activity" },
            { label:"reflect", bg:C.blueLight,  text:C.blue,    border:C.blueBorder,  desc:"Reflection" },
          ].map(l => (
            <div key={l.label} style={{ display:"flex", alignItems:"center", gap:4, fontSize:10, color:C.textMuted }}>
              <span style={{ display:"inline-flex", borderRadius:999, padding:"1px 5px", fontSize:8, fontWeight:500, border:`0.5px solid ${l.border}`, background:l.bg, color:l.text }}>{l.label}</span>
              {l.desc}
            </div>
          ))}
        </div>
      </div>

      <DragHandle onMouseDown={onDragGrid} />

      {/* ── RIGHT: DAY DETAIL ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", borderLeft:`0.5px solid ${C.border}` }}>
        {/* Header */}
        <div style={{ padding:"12px 16px 10px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, display:"flex", alignItems:"flex-start", justifyContent:"space-between", flexShrink:0 }}>
          <div>
            <div style={{ fontSize:16, fontWeight:500, color:C.text }}>{dayLabel}</div>
            {daySub && <div style={{ fontSize:11, color:C.textMuted, marginTop:2 }}>{daySub}</div>}
          </div>
          <Pill onClick={() => setShowAddTask(v => !v)}
            style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:10, padding:"3px 11px", cursor:"pointer" }}>+ Add task</Pill>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"12px 16px", display:"flex", flexDirection:"column", gap:12 }}>

          {/* Add task inline form */}
          {showAddTask && (
            <div style={{ background:C.tealLight, border:`0.5px solid ${C.tealBorder}`, borderRadius:8, padding:"10px 12px", display:"flex", flexDirection:"column", gap:8 }}>
              <SectionLabel>New task — {new Date(selectedDay+"T12:00:00").toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</SectionLabel>
              <input autoFocus value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
                placeholder="Task title…"
                onKeyDown={e => { if (e.key==="Enter") saveNewTask(); if (e.key==="Escape") setShowAddTask(false); }}
                style={{ width:"100%", border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"5px 8px", fontSize:12, fontFamily:"inherit", outline:"none", background:"white", color:C.text }} />
              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                <select value={newTaskPriority} onChange={e => setNewTaskPriority(e.target.value)}
                  style={{ border:`0.5px solid ${C.tealBorder}`, borderRadius:6, padding:"4px 8px", fontSize:11, fontFamily:"inherit", color:C.text }}>
                  {PRIORITIES.map(p => <option key={p} value={p}>{PRI_WORD[p]}</option>)}
                </select>
                <div style={{ flex:1 }} />
                <Btn onClick={() => setShowAddTask(false)}>Cancel</Btn>
                <Btn variant="solid" onClick={saveNewTask}>{addSaving ? "Saving…" : "Save task"}</Btn>
              </div>
            </div>
          )}

          {/* Tasks due */}
          <div>
            <SectionLabel>Tasks due</SectionLabel>
            {dayTasks.length === 0 ? (
              <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No tasks due</div>
            ) : dayTasks.map(t => {
              const overdue = isOverdue(t.due_date);
              const dueToday = isToday(t.due_date);
              const dn = t.card_id ? dealName(t.card_id) : null;
              const circleColour = overdue ? C.red : dueToday ? C.green : C.borderMid;
              return (
                <div key={t.id}
                  onClick={() => setSelectedTaskId(t.id)}
                  style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px",
                    border:`0.5px solid ${selectedTaskId === t.id ? C.tealBorder : C.border}`,
                    borderRadius:7, marginBottom:5,
                    background: selectedTaskId === t.id ? C.tealLight : "transparent",
                    cursor:"pointer", transition:"background 0.1s" }}
                  onMouseEnter={e => { if (selectedTaskId !== t.id) e.currentTarget.style.background = C.bgSecondary; }}
                  onMouseLeave={e => { if (selectedTaskId !== t.id) e.currentTarget.style.background = "transparent"; }}>
                  <div style={{ width:14, height:14, borderRadius:"50%", border:`1.5px solid ${circleColour}`, flexShrink:0 }} />
                  <span style={{ fontSize:11, fontWeight:500, color:C.text, flex:1 }}>{t.title}</span>
                  {dn && (
                    <Pill
                      onClick={e => { e.stopPropagation(); onNavigate && onNavigate({ view:"board", dealId:t.card_id }); }}
                      style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:9, padding:"1px 6px", cursor:"pointer" }}>
                      🔗 {dn}
                    </Pill>
                  )}
                  {overdue && <span style={{ fontSize:9, color:C.red, fontWeight:500, flexShrink:0 }}>Overdue</span>}
                </div>
              );
            })}
          </div>

          {/* Deal activity */}
          <div>
            <SectionLabel>Deal activity</SectionLabel>
            {dayThreads.length === 0 ? (
              <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>No activity logged</div>
            ) : (
              <div style={{ paddingLeft:4 }}>
                {dayThreads.map((e, idx) => {
                  const deal = e.card_id ? state.deals[e.card_id] : null;
                  const label = deal ? (deal.deal_name || deal.name || e.card_id) : null;
                  return (
                    <ActivityEntry
                      key={e.id}
                      entry={e}
                      onDelete={() => {}}
                      dispatch={dispatch}
                      readOnly={true}
                      isLast={idx === dayThreads.length - 1}
                      dealLabel={label}
                      onDealClick={e.card_id && onNavigate ? () => onNavigate({ view:"board", dealId:e.card_id, tab:"activity" }) : null}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* Reflection — read-only, links to Journal */}
          <div>
            <SectionLabel>Reflection</SectionLabel>
            <div style={{ padding:"10px 12px", border:`0.5px solid ${C.blueBorder}`, borderRadius:7, background:C.blueLight }}>
              {dayReflect?.text ? (
                <div style={{ fontSize:11, color:C.blue, lineHeight:1.6 }}>
                  {/* Show first non-empty line as preview */}
                  {dayReflect.text.split("\n").find(l => l.trim()) || ""}
                  {dayReflect.text.split("\n").filter(l => l.trim()).length > 1 && (
                    <span style={{ color:C.blue, opacity:0.6 }}> …</span>
                  )}
                </div>
              ) : (
                <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic" }}>
                  No reflection for this day.
                </div>
              )}
              {onNavigate && (
                <div onClick={() => onNavigate({ view:"journal" })}
                  style={{ fontSize:10, color:C.blue, cursor:"pointer", textDecoration:"underline", marginTop:6 }}>
                  {dayReflect?.text ? "Read in Journal →" : "Write one in the Journal →"}
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* ── TASK DETAIL PANEL — slides in from right when a task is selected ── */}
      {selectedTaskId && state.tasks[selectedTaskId] && (() => {
        const t = state.tasks[selectedTaskId];
        const dn = t.card_id ? dealName(t.card_id) : null;
        return (
          <div style={{
            width: 420, flexShrink:0,
            borderLeft:`0.5px solid ${C.border}`,
            display:"flex", flexDirection:"column",
            background: C.bg, overflowY:"auto",
          }}>
            <div style={{ display:"flex", justifyContent:"flex-end",
              padding:"8px 12px", borderBottom:`0.5px solid ${C.border}`,
              background: C.panelHeader }}>
              <span onClick={() => setSelectedTaskId(null)}
                style={{ fontSize:11, color:C.textMuted, cursor:"pointer",
                  padding:"3px 8px", borderRadius:6, border:`0.5px solid ${C.borderMid}` }}>
                ✕ Close
              </span>
            </div>
            <TaskDetail
              key={selectedTaskId}
              task={t}
              dealName={dn}
              state={state}
              dispatch={dispatch}
              onDeleted={() => setSelectedTaskId(null)}
              onCompleted={() => setSelectedTaskId(null)}
              onNavigate={onNavigate}
            />
          </div>
        );
      })()}
    </div>
  );
}

// ── PIPELINE SCREEN ──
function PipelineScreen({ state }) {
  const deals = Object.values(state.deals).filter(d => !d.archived);

  const byState = {
    potential: deals.filter(d => (d.state||d.status||"potential") === "potential"),
    active:    deals.filter(d => (d.state||d.status||"potential") === "active"),
    dormant:   deals.filter(d => (d.state||d.status||"potential") === "dormant"),
  };

  const STAGE_CONFIG = [
    { key:"potential", label:"Potential", bg:C.amberLight,   text:C.amber,    border:C.amberBorder,   icon:"◎" },
    { key:"active",    label:"Active",    bg:C.tealLight,    text:C.tealText, border:C.tealBorder,    icon:"●" },
    { key:"dormant",   label:"Dormant",   bg:C.bgSecondary,  text:C.textMuted,border:C.border,        icon:"○" },
  ];

  const totalDeals = deals.length;
  const activeDeals = byState.active.length;
  const heatHot = deals.filter(d => (d.heat||0) >= 4).length;

  const buyerName = (id) => { const b = state.buyers[id]; return b ? (b.company_name||b.name||`${b.first_name||""} ${b.last_name||""}`.trim()||id) : id; };

  const HEAT_LABEL = ["", "❄", "🌡", "🌡🌡", "🔥", "🔥🔥"];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", overflow:"hidden" }}>

      {/* Header */}
      <div style={{ padding:"10px 18px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span style={{ fontSize:13, fontWeight:500, color:C.text }}>Pipeline</span>
        <div style={{ display:"flex", gap:14 }}>
          {[
            { label:"Total deals",   value:totalDeals },
            { label:"Active",        value:activeDeals,  colour:C.tealText },
            { label:"Hot deals",     value:heatHot,      colour:C.red },
          ].map(s => (
            <div key={s.label} style={{ textAlign:"center" }}>
              <div style={{ fontSize:20, fontWeight:600, color:s.colour||C.text, lineHeight:1 }}>{s.value}</div>
              <div style={{ fontSize:9, color:C.textDim, marginTop:2, textTransform:"uppercase", letterSpacing:"0.05em" }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Stage funnel bar */}
      <div style={{ padding:"10px 18px", borderBottom:`0.5px solid ${C.border}`, background:"white", flexShrink:0 }}>
        <div style={{ display:"flex", gap:3, height:8, borderRadius:999, overflow:"hidden" }}>
          {STAGE_CONFIG.map(s => {
            const pct = totalDeals ? (byState[s.key].length / totalDeals) * 100 : 0;
            if (pct === 0) return null;
            return <div key={s.key} style={{ flex:pct, background: s.key==="active" ? C.teal : s.key==="potential" ? C.amber : C.textDim, transition:"flex 0.3s" }} />;
          })}
        </div>
        <div style={{ display:"flex", gap:14, marginTop:8 }}>
          {STAGE_CONFIG.map(s => (
            <div key={s.key} style={{ display:"flex", alignItems:"center", gap:5 }}>
              <div style={{ width:8, height:8, borderRadius:2, background: s.key==="active" ? C.teal : s.key==="potential" ? C.amber : C.textDim, flexShrink:0 }} />
              <span style={{ fontSize:10, color:C.textMuted }}>{s.label}</span>
              <span style={{ fontSize:10, fontWeight:600, color:C.text }}>{byState[s.key].length}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Deal table — one section per stage */}
      <div style={{ flex:1, overflowY:"auto" }}>
        {STAGE_CONFIG.map(stage => {
          const stageDeal = byState[stage.key];
          if (stageDeal.length === 0) return null;
          const sorted = [...stageDeal].sort((a,b) => (b.heat||0) - (a.heat||0));
          return (
            <div key={stage.key}>
              {/* Section header */}
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 18px 5px", background:C.bgSecondary, borderBottom:`0.5px solid ${C.border}`, position:"sticky", top:0, zIndex:1 }}>
                <Pill style={{ background:stage.bg, color:stage.text, borderColor:stage.border, fontSize:10 }}>
                  {stage.icon} {stage.label}
                </Pill>
                <span style={{ fontSize:10, color:C.textDim }}>{stageDeal.length} deal{stageDeal.length!==1?"s":""}</span>
              </div>

              {/* Table header */}
              <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 80px", gap:0, padding:"5px 18px", borderBottom:`0.5px solid ${C.border}`, background:"white" }}>
                {["Deal","Buyer","Instrument","Commodity","Heat"].map((h,i) => (
                  <div key={h} style={{ fontSize:9, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:C.textDim, textAlign: i===4 ? "center" : "left" }}>{h}</div>
                ))}
              </div>

              {/* Rows */}
              {sorted.map(d => (
                <div key={d.id} style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 80px", gap:0, padding:"8px 18px", borderBottom:`0.5px solid ${C.border}`, alignItems:"center" }}
                  onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <div style={{ fontSize:12, fontWeight:500, color:C.text }}>{d.deal_name||d.name||d.id}</div>
                  <div style={{ fontSize:11, color:C.textMuted }}>{d.buyer_id ? buyerName(d.buyer_id) : "—"}</div>
                  <div>
                    {d.instrument
                      ? <InstrPill instrument={d.instrument} />
                      : <span style={{ fontSize:11, color:C.textDim }}>—</span>}
                  </div>
                  <div>
                    {d.commodity
                      ? <CommodityPill commodity={d.commodity} />
                      : <span style={{ fontSize:11, color:C.textDim }}>—</span>}
                  </div>
                  <div style={{ textAlign:"center", fontSize:13 }}>{HEAT_LABEL[d.heat||0] || "—"}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ARCHIVE SCREEN ──
function ArchiveScreen({ state, dispatch }) {
  const { confirmEl, confirm } = useConfirm();
  const [filter, setFilter] = useState("all");
  const [archivedDeals, setArchivedDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [leftWidth, onDragLeft] = useDraggablePanel(340, 220, 560);

  useEffect(() => {
    setLoading(true);
    sb.select("deals", "archived=eq.true&order=created_at.desc")
      .then(rows => { setArchivedDeals(rows || []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  const filtered = archivedDeals.filter(d =>
    filter === "all" || (d.state || "") === filter
  );

  const wonCount  = archivedDeals.filter(d => d.state === "closed_won").length;
  const lostCount = archivedDeals.filter(d => d.state === "closed_lost").length;

  const buyerName = (id) => {
    const b = state.buyers[id];
    return b ? (b.company_name || b.name || `${b.first_name||""} ${b.last_name||""}`.trim() || id) : id;
  };

  const restore = async (deal) => {
    try {
      await sb.update("deals", deal.id, { archived: false, state: "potential" });
      setArchivedDeals(prev => prev.filter(d => d.id !== deal.id));
      dispatch({ type:"ADD_DEAL", deal:{ ...deal, archived:false, state:"potential" } });
      if (selectedId === deal.id) setSelectedId(null);
    } catch(e) { console.error(e); }
  };

  const deleteDeal = async (deal) => {
    if (!await confirm(`Permanently delete "${deal.deal_name || "this deal"}"? This cannot be undone.`)) return;
    try {
      await sb.delete("deals", deal.id);
      setArchivedDeals(prev => prev.filter(d => d.id !== deal.id));
      if (selectedId === deal.id) setSelectedId(null);
    } catch(e) { console.error(e); }
  };

  const stateIconStyle = (s) => s === "closed_won"
    ? { background:C.greenLight, border:`0.5px solid ${C.greenBorder}`, color:C.green }
    : { background:C.redLight,   border:`0.5px solid ${C.redBorder}`,   color:C.red };

  const FILTERS = [
    { key:"all",         label:"All",           bg:C.tealLight,  text:C.tealText, border:C.tealBorder,   count:archivedDeals.length },
    { key:"closed_won",  label:"Closed / Won",  bg:C.greenLight, text:C.green,    border:C.greenBorder,  count:wonCount },
    { key:"closed_lost", label:"Closed / Lost", bg:C.redLight,   text:C.red,      border:C.redBorder,    count:lostCount },
  ];

  // Merge archived deal into state so DealPanel can find it
  const selectedDeal = archivedDeals.find(d => d.id === selectedId);
  const augmentedState = selectedDeal
    ? { ...state, deals: { ...state.deals, [selectedDeal.id]: selectedDeal } }
    : state;

  return (
    <div style={{ display:"flex", height:"100%", overflow:"hidden" }}>

      {/* ── LEFT LIST ── */}
      <div style={{ width:leftWidth, flexShrink:0, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        {/* Header */}
        <div style={{ padding:"10px 16px", borderBottom:`0.5px solid ${C.border}`, background:C.panelHeader, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <span style={{ fontSize:13, fontWeight:500, color:C.text }}>Archive</span>
          <div style={{ fontSize:11, color:C.textDim }}>{archivedDeals.length} deal{archivedDeals.length !== 1 ? "s" : ""}</div>
        </div>

        {/* Filter pills */}
        <div style={{ padding:"8px 16px", borderBottom:`0.5px solid ${C.border}`, display:"flex", gap:6, flexShrink:0, flexWrap:"wrap" }}>
          {FILTERS.map(f => (
            <span key={f.key} onClick={() => setFilter(f.key)}
              style={{ display:"inline-flex", alignItems:"center", gap:5, borderRadius:999,
                padding:"4px 11px", fontSize:10, fontWeight:500, border:"0.5px solid",
                cursor:"pointer", userSelect:"none",
                background: filter === f.key ? f.bg : "transparent",
                color: filter === f.key ? f.text : C.textMuted,
                borderColor: filter === f.key ? f.border : C.borderMid }}>
              {f.label} <span style={{ fontSize:9, opacity:0.7 }}>{f.count}</span>
            </span>
          ))}
        </div>

        {/* List */}
        <div style={{ flex:1, overflowY:"auto", padding:"8px 12px", display:"flex", flexDirection:"column", gap:5 }}>
          {loading && <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic", padding:8 }}>Loading…</div>}
          {error && <div style={{ fontSize:11, color:C.red, padding:8 }}>Failed to load: {error}</div>}
          {!loading && filtered.length === 0 && (
            <div style={{ fontSize:11, color:C.textDim, fontStyle:"italic", padding:8 }}>
              {archivedDeals.length === 0 ? "No archived deals yet" : "No deals match this filter"}
            </div>
          )}
          {filtered.map(deal => {
            const s = deal.state || "closed_lost";
            const iStyle = stateIconStyle(s);
            const isSelected = selectedId === deal.id;
            return (
              <div key={deal.id} onClick={() => setSelectedId(isSelected ? null : deal.id)}
                style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 10px",
                  border:`0.5px solid ${isSelected ? C.teal : C.border}`,
                  borderRadius:8, cursor:"pointer",
                  background: isSelected ? C.tealLight : "white",
                  transition:"background 0.1s" }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = C.bgSecondary; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "white"; }}>
                <div style={{ width:28, height:28, borderRadius:6, display:"flex", alignItems:"center",
                  justifyContent:"center", fontSize:13, flexShrink:0, ...iStyle }}>
                  {s === "closed_won" ? "🏆" : "✗"}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:500, color:C.text, marginBottom:2,
                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                    {deal.deal_name || deal.name || deal.id}
                  </div>
                  <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
                    <span style={{ fontSize:9, fontWeight:500,
                      color: s === "closed_won" ? C.green : C.red }}>
                      {s === "closed_won" ? "Won" : "Lost"}
                    </span>
                    {deal.instrument && <InstrPill instrument={deal.instrument} />}
                    {deal.buyer_id && <span style={{ fontSize:10, color:C.textDim }}>{buyerName(deal.buyer_id)}</span>}
                  </div>
                  {deal.resolution && (
                    <div style={{ fontSize:10, color:C.textMuted, marginTop:3, lineHeight:1.4,
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                      {deal.resolution}
                    </div>
                  )}
                </div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4, flexShrink:0 }}>
                  <span style={{ fontSize:9, color:C.textDim }}>{deal.updated_at ? fmtDate(deal.updated_at) : ""}</span>
                  <div style={{ display:"flex", gap:4 }}>
                    <Pill onClick={e => { e.stopPropagation(); restore(deal); }}
                      style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:9, padding:"1px 6px", cursor:"pointer" }}>↺</Pill>
                    <Pill onClick={e => { e.stopPropagation(); deleteDeal(deal); }}
                      style={{ background:C.redLight, color:C.red, borderColor:C.redBorder, fontSize:9, padding:"1px 6px", cursor:"pointer" }}>🗑</Pill>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <DragHandle onMouseDown={onDragLeft} />

      {/* ── RIGHT: DEAL PANEL ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", borderLeft:`0.5px solid ${C.border}` }}>
        {selectedDeal ? (
          <DealPanel
            dealId={selectedId}
            state={augmentedState}
            dispatch={dispatch}
            onClose={() => setSelectedId(null)}
            width={undefined}
            onDragWidth={() => {}}
            readOnly={true}
            onRestore={() => restore(selectedDeal)}
          />
        ) : (
          <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
            flexDirection:"column", gap:8, color:C.textDim }}>
            <div style={{ fontSize:28, opacity:0.2 }}>🗄</div>
            <div style={{ fontSize:12 }}>Select a deal to view its details</div>
          </div>
        )}
      </div>
      {confirmEl}
    </div>
  );
}

function ArchiveRow({ deal, iconStyle, stateIcon, sc, s, buyerName, onRestore, onDelete }) {
  const [hovered, setHovered] = useState(false);
  const archivedAt = deal.updated_at || deal.created_at;
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px",
        border:`0.5px solid ${C.border}`, borderRadius:8,
        background: hovered ? C.bgSecondary : "white", transition:"background 0.1s" }}>
      <div style={{ width:32, height:32, borderRadius:6, display:"flex", alignItems:"center",
        justifyContent:"center", fontSize:14, flexShrink:0, ...iconStyle }}>{stateIcon}</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:12, fontWeight:500, color:C.text, marginBottom:3 }}>{deal.deal_name || deal.name || deal.id}</div>
        <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
          <Pill style={{ background:sc.bg, color:sc.text, borderColor:sc.border, fontSize:9, padding:"1px 6px" }}>
            {s === "closed_won" ? "Closed / Won" : "Closed / Lost"}
          </Pill>
          {deal.instrument && <InstrPill instrument={deal.instrument} />}
          {deal.commodity && <CommodityPill commodity={deal.commodity} />}
          {deal.buyer_id && <span style={{ fontSize:10, color:C.textDim }}>{buyerName(deal.buyer_id)}</span>}
        </div>
      </div>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:5, flexShrink:0 }}>
        <span style={{ fontSize:10, color:C.textDim }}>{archivedAt ? fmtDate(archivedAt) : ""}</span>
        {hovered && (
          <div style={{ display:"flex", gap:5 }}>
            <Pill onClick={() => onRestore(deal)} style={{ background:C.tealLight, color:C.tealText, borderColor:C.tealBorder, fontSize:9, padding:"2px 8px", cursor:"pointer" }}>↺ Restore</Pill>
            <Pill onClick={() => onDelete(deal)} style={{ background:C.redLight, color:C.red, borderColor:C.redBorder, fontSize:9, padding:"2px 8px", cursor:"pointer" }}>🗑 Delete</Pill>
          </div>
        )}
      </div>
    </div>
  );
}

// ── PLACEHOLDER VIEWS ──
function PlaceholderView({ name }) {
  return (
    <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8, color:C.textDim }}>
      <div style={{ fontSize:32, opacity:0.2 }}>🚧</div>
      <div style={{ fontSize:13, fontWeight:500 }}>{name}</div>
      <div style={{ fontSize:11 }}>Coming in next build</div>
    </div>
  );
}

// ── MAIN APP ──
// ── UNIVERSAL SEARCH ──
function UniversalSearch({ state, onNavigate, darkTheme }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  const q = query.trim().toLowerCase();

  const results = q.length < 2 ? [] : (() => {
    const hits = [];

    // Pull a short excerpt of matched text around the query, for use as a result subline
    const excerpt = (str, query, pad = 30) => {
      const lower = str.toLowerCase();
      const idx = lower.indexOf(query);
      if (idx === -1) return str.slice(0, 60);
      const start = Math.max(0, idx - pad);
      const end = Math.min(str.length, idx + query.length + pad);
      return (start > 0 ? "…" : "") + str.slice(start, end).trim() + (end < str.length ? "…" : "");
    };

    // Deals
    Object.values(state.deals).filter(d => !d.archived).forEach(d => {
      const text = [d.deal_name, d.description, d.instrument, d.commodity, d.location, d.notes, d.buyer_name].filter(Boolean).join(" ").toLowerCase();
      if (text.includes(q)) hits.push({ type:"deal", id:d.id, label:d.deal_name||d.id, sub: [d.instrument, d.commodity].filter(Boolean).join(" · "), icon:"🗂", nav:{ view:"board", dealId:d.id } });

      // Deal activity notes — thread entries logged against this deal.
      // A match here jumps straight to the Activity tab and highlights the note.
      Object.values(state.threads).filter(e => e.card_id === d.id && e.card_type === "deal").forEach(e => {
        const noteText = e.text || "";
        if (noteText.toLowerCase().includes(q)) {
          hits.push({ type:"deal", id:`${d.id}-note-${e.id}`, label:d.deal_name||d.id, sub: excerpt(noteText, q), icon:"🗂", nav:{ view:"board", dealId:d.id, tab:"activity", noteId:e.id, noteQuery:q } });
        }
      });
    });

    // Sellers
    Object.values(state.sellers).forEach(s => {
      const name = s.company_name||`${s.first_name||""} ${s.last_name||""}`.trim();
      const text = [name, s.email, s.phone, s.domicile, s.notes, s.bank, s.mandate, ...(s.capabilities||[]), ...(s.commodities||[])].filter(Boolean).join(" ").toLowerCase();
      if (text.includes(q)) hits.push({ type:"seller", id:s.id, label:name||s.id, sub: s.domicile||"", icon:"◆", nav:{ view:"sellers", selectedId:s.id } });
    });

    // Buyers
    Object.values(state.buyers).forEach(b => {
      const name = b.company_name||b.name||`${b.first_name||""} ${b.last_name||""}`.trim();
      const text = [name, b.email, b.phone, b.location, b.notes, ...(b.instruments||[]), ...(b.commodities||[])].filter(Boolean).join(" ").toLowerCase();
      if (text.includes(q)) hits.push({ type:"buyer", id:b.id, label:name||b.id, sub: b.location||"", icon:"◇", nav:{ view:"buyers", selectedId:b.id } });
    });

    // People
    Object.values(state.people).forEach(p => {
      const name = `${p.first_name||""} ${p.last_name||""}`.trim()||p.company;
      const text = [name, p.company, p.role, p.email, p.phone, p.notes].filter(Boolean).join(" ").toLowerCase();
      if (text.includes(q)) hits.push({ type:"person", id:p.id, label:name||p.id, sub: [p.company, p.role].filter(Boolean).join(" · "), icon:"👤", nav:{ view:"people", selectedId:p.id } });
    });

    // Tasks
    Object.values(state.tasks).filter(t => t.status !== "archived").forEach(t => {
      const text = [t.title, t.description, t.resolution].filter(Boolean).join(" ").toLowerCase();
      if (text.includes(q)) hits.push({ type:"task", id:t.id, label:t.title, sub: t.due_date ? fmtDate(t.due_date) : "No date", icon:"✓", nav:{ view:"tasks", selectedId:t.id } });

      // Task progress notes — thread entries logged against this task.
      // A match here jumps straight to the task and highlights the matched note.
      Object.values(state.threads).filter(e => e.card_id === t.id && e.card_type === "task").forEach(e => {
        const noteText = e.text || "";
        if (noteText.toLowerCase().includes(q)) {
          hits.push({ type:"task", id:`${t.id}-note-${e.id}`, label:t.title, sub: excerpt(noteText, q), icon:"✓", nav:{ view:"tasks", selectedId:t.id, noteId:e.id, noteQuery:q } });
        }
      });
    });

    return hits.slice(0, 24);
  })();

  // Group by type
  const groups = ["deal","seller","buyer","person","task"];
  const GROUP_LABEL = { deal:"Deals", seller:"Sellers", buyer:"Buyers", person:"People", task:"Tasks" };
  const grouped = groups.map(type => ({ type, label:GROUP_LABEL[type], items: results.filter(r => r.type === type) })).filter(g => g.items.length > 0);

  const handleSelect = (hit) => {
    onNavigate(hit.nav);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) { setOpen(false); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const TYPE_ACCENT = {
    deal:   { color:C.tealText,   bg:C.tealLight },
    seller: { color:C.tealText,   bg:C.tealLight },
    buyer:  { color:C.blue,       bg:C.blueLight },
    person: { color:"#5b21b6",    bg:C.purpleLight },
    task:   { color:C.textMuted,  bg:C.bgSecondary },
  };

  return (
    <div ref={containerRef} style={{ padding:"8px 10px", borderBottom:`1px solid ${darkTheme ? C.sidebarBorder : C.borderLight}`, position:"relative" }}>
      <div style={{ display:"flex", alignItems:"center", gap:6,
        background: darkTheme ? C.sidebarHover : "white",
        border:`1px solid ${darkTheme ? C.sidebarBorder : C.borderLight}`,
        borderRadius:7, padding:"5px 9px" }}>
        <span style={{ fontSize:12, color: darkTheme ? C.sidebarMuted : C.textDim, flexShrink:0 }}>🔍</span>
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search everything…"
          style={{ flex:1, border:"none", outline:"none", fontSize:11, fontFamily:"inherit",
            color: darkTheme ? C.sidebarText : C.text, background:"transparent" }}
        />
        {query && (
          <span onClick={() => { setQuery(""); setOpen(false); }}
            style={{ fontSize:11, color: darkTheme ? C.sidebarMuted : C.textDim, cursor:"pointer", flexShrink:0 }}>✕</span>
        )}
      </div>

      {/* Results dropdown */}
      {open && query.length >= 2 && (
        <div style={{
          position:"absolute", top:"calc(100% - 2px)", left:8, right:8,
          background:"white", border:`0.5px solid ${C.border}`, borderRadius:8,
          boxShadow:"0 8px 24px rgba(0,0,0,0.12)", zIndex:100,
          maxHeight:380, overflowY:"auto",
        }}>
          {grouped.length === 0 ? (
            <div style={{ padding:"14px 12px", fontSize:11, color:C.textDim, fontStyle:"italic", textAlign:"center" }}>No results for "{query}"</div>
          ) : (
            grouped.map(g => (
              <div key={g.type}>
                <div style={{ padding:"7px 12px 3px", fontSize:9, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.08em", color:C.textDim, background:C.bgSecondary, borderBottom:`0.5px solid ${C.border}` }}>
                  {g.label}
                </div>
                {g.items.map(hit => {
                  const acc = TYPE_ACCENT[hit.type] || TYPE_ACCENT.task;
                  return (
                    <div key={hit.id} onClick={() => handleSelect(hit)}
                      style={{ display:"flex", alignItems:"center", gap:9, padding:"8px 12px", cursor:"pointer", borderBottom:`0.5px solid ${C.border}` }}
                      onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
                      onMouseLeave={e => e.currentTarget.style.background = "white"}>
                      <span style={{ fontSize:13, width:18, textAlign:"center", flexShrink:0 }}>{hit.icon}</span>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:12, fontWeight:500, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{hit.label}</div>
                        {hit.sub && <div style={{ fontSize:10, color:C.textDim, marginTop:1 }}>{hit.sub}</div>}
                      </div>
                      <span style={{ fontSize:9, background:acc.bg, color:acc.color, borderRadius:999, padding:"1px 6px", flexShrink:0, fontWeight:500 }}>{GROUP_LABEL[hit.type].slice(0,-1)}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── ADMIN SCREEN ──
function AdminScreen({ state }) {
  const [liveCount, setLiveCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [lastChecked, setLastChecked] = useState(null);

  const tables = [
    { name:"deals",         label:"Deals",          stateCount: Object.keys(state.deals||{}).length },
    { name:"thread_entries",label:"Activity entries",stateCount: Object.keys(state.threads||{}).length },
    { name:"tasks",         label:"Tasks",          stateCount: Object.keys(state.tasks||{}).length },
    { name:"documents",     label:"Documents",      stateCount: Object.keys(state.documents||{}).length },
    { name:"sellers",       label:"Sellers",        stateCount: Object.keys(state.sellers||{}).length },
    { name:"buyers",        label:"Buyers",         stateCount: Object.keys(state.buyers||{}).length },
    { name:"people",        label:"People",         stateCount: Object.keys(state.people||{}).length },
    { name:"journal",       label:"Journal entries",stateCount: Object.keys(state.journal||{}).length },
  ];

  const checkLive = async () => {
    setLoading(true);
    try {
      const results = {};
      await Promise.all(tables.map(async t => {
        const res = await fetch(
          `${SUPA_URL}/rest/v1/${t.name}?select=id`,
          { headers:{ apikey: SUPA_KEY, Authorization:`Bearer ${SUPA_KEY}`, "Prefer":"count=exact", "Range":"0-0" } }
        );
        const count = res.headers.get("content-range")?.split("/")[1];
        results[t.name] = count ? parseInt(count) : "?";
      }));
      setLiveCount(results);
      setLastChecked(new Date().toLocaleTimeString("en-GB"));
    } catch(e) { console.error(e); }
    setLoading(false);
  };

  return (
    <div style={{ flex:1, overflowY:"auto", padding:24 }}>
      <div style={{ maxWidth:600 }}>
        <div style={{ fontSize:18, fontWeight:700, color:C.text, marginBottom:4 }}>Data Integrity</div>
        <div style={{ fontSize:11, color:C.textMuted, marginBottom:20 }}>
          Compare in-memory state counts against live Supabase row counts. A discrepancy may indicate a load failure or filter issue.
        </div>

        <div style={{ display:"flex", gap:10, marginBottom:20, alignItems:"center" }}>
          <Btn variant="teal" onClick={checkLive} style={{ fontSize:11 }}>
            {loading ? "Checking…" : "↻ Check live counts"}
          </Btn>
          {lastChecked && <span style={{ fontSize:10, color:C.textDim }}>Last checked: {lastChecked}</span>}
        </div>

        <div style={{ border:`0.5px solid ${C.border}`, borderRadius:8, overflow:"hidden" }}>
          {/* Header */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 100px 100px 80px", padding:"8px 14px",
            background:C.bgSecondary, borderBottom:`0.5px solid ${C.border}` }}>
            <div style={{ fontSize:10, fontWeight:600, color:C.textMuted, textTransform:"uppercase", letterSpacing:0.5 }}>Table</div>
            <div style={{ fontSize:10, fontWeight:600, color:C.textMuted, textTransform:"uppercase", letterSpacing:0.5, textAlign:"right" }}>In memory</div>
            <div style={{ fontSize:10, fontWeight:600, color:C.textMuted, textTransform:"uppercase", letterSpacing:0.5, textAlign:"right" }}>In Supabase</div>
            <div style={{ fontSize:10, fontWeight:600, color:C.textMuted, textTransform:"uppercase", letterSpacing:0.5, textAlign:"right" }}>Status</div>
          </div>

          {tables.map((t, idx) => {
            const live = liveCount ? liveCount[t.name] : null;
            const mismatch = live !== null && live !== t.stateCount;
            return (
              <div key={t.name} style={{ display:"grid", gridTemplateColumns:"1fr 100px 100px 80px",
                padding:"10px 14px", borderBottom: idx < tables.length-1 ? `0.5px solid ${C.border}` : "none",
                background: mismatch ? "#fff9f9" : "white" }}>
                <div style={{ fontSize:12, color:C.text, fontWeight:500 }}>{t.label}</div>
                <div style={{ fontSize:12, color:C.text, textAlign:"right" }}>{t.stateCount}</div>
                <div style={{ fontSize:12, color:C.text, textAlign:"right" }}>
                  {loading ? <span style={{ color:C.textDim }}>…</span> : live !== null ? live : <span style={{ color:C.textDim }}>—</span>}
                </div>
                <div style={{ fontSize:11, textAlign:"right" }}>
                  {mismatch
                    ? <span style={{ color:C.red, fontWeight:600 }}>⚠ Mismatch</span>
                    : live !== null
                      ? <span style={{ color:C.green }}>✓ Match</span>
                      : <span style={{ color:C.textDim }}>—</span>
                  }
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop:24, padding:14, background:C.amberLight, border:`0.5px solid ${C.amberBorder}`, borderRadius:8 }}>
          <div style={{ fontSize:11, fontWeight:600, color:C.amber, marginBottom:6 }}>What to check</div>
          <div style={{ fontSize:11, color:"#78350f", lineHeight:1.7 }}>
            A <strong>mismatch</strong> between in-memory and Supabase counts usually means either:<br/>
            1. A filter in the app is hiding records from the UI (data is safe in Supabase)<br/>
            2. A load failure on startup — try refreshing the page<br/>
            3. Records were deleted unexpectedly — check the table in Supabase directly<br/><br/>
            Check live counts at the <strong>start and end</strong> of every development session.
            If any count drops during a session, data may have been deleted.
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [state, dispatch] = useReducer(reducer, INIT);
  const [view, setView] = useState("board");
  const [selectedDealId, setSelectedDealId] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [searchNav, setSearchNav] = useState(null);
  // Carries a search-driven "jump to this note" target into the Deal panel's
  // Activity tab. Separate from searchNav because DealPanel remounts (via
  // navKey in its key prop) on every search nav, so this only needs to be
  // read once on mount rather than watched with a useEffect.
  const [searchNoteId, setSearchNoteId] = useState(null);
  const [searchNoteQuery, setSearchNoteQuery] = useState(null);
  const hasLoadedRef = useRef(false);

  // Load from Supabase on mount.
  // Guarded so that if this effect ever fires more than once (StrictMode
  // double-invoke, unexpected remount, tab restore quirks), the second
  // load is ignored rather than overwriting live in-memory edits with a
  // stale snapshot. This is a deliberate safeguard after a real incident
  // where a second LOAD silently discarded unsaved-looking-but-actually-
  // already-saved progress notes and task status changes.
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    loadAll()
      .then(payload => dispatch({ type:"LOAD", payload }))
      .catch(e => { console.error("Load failed:", e); setLoadError(e.message); dispatch({ type:"LOAD", payload:{} }); });
  }, []);

  const [dealPanelTab, setDealPanelTab] = useState(null);
  const [navKey, setNavKey] = useState(0);

  const [boardTab, setBoardTab] = useState(null);
  const [lastBoardTab, setLastBoardTab] = useState("active");

  // Queued nav: if a navigation arrives before initial load has finished
  // (e.g. clicking the Lead pill in Tasks right after a hard refresh),
  // we hold the request and replay it once state.loaded flips true,
  // instead of firing setSelectedDealId against an empty state.deals
  // and having DealPanel silently render nothing.
  const pendingNavRef = useRef(null);

  const runSearchNav = ({ view: v, selectedId, dealId, tab, boardTab: bt, filterCardId: fci, noteId, noteQuery }) => {
    setView(v);
    setSelectedDealId(dealId || null);
    setDealPanelTab(tab || null);
    if (bt) setBoardTab(bt);
    setNavKey(k => k + 1);
    setSearchNoteId(noteId || null);
    setSearchNoteQuery(noteQuery || null);
    // Always include a ts so repeated nav to same selectedId/filterCardId still triggers useEffect
    setSearchNav(
      selectedId ? { view: v, selectedId, noteId: noteId || null, noteQuery: noteQuery || null, ts: Date.now() }
      : fci ? { view: v, filterCardId: fci, ts: Date.now() }
      : null
    );
  };

  const handleSearchNav = (navArgs) => {
    if (!state.loaded) {
      pendingNavRef.current = navArgs;
      return;
    }
    runSearchNav(navArgs);
  };

  // Replay a queued navigation once initial load completes.
  useEffect(() => {
    if (state.loaded && pendingNavRef.current) {
      const queued = pendingNavRef.current;
      pendingNavRef.current = null;
      runSearchNav(queued);
    }
  }, [state.loaded]);

  const navigate = (id) => {
    setView(id);
    if (id !== "board") setSelectedDealId(null);
    if (id === "board") setBoardTab(lastBoardTab);
    setSearchNav(null);
  };

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [darkTheme, setDarkTheme] = useState(true);
  const [dealPanelWidth, onDragDealPanel] = useDraggablePanel(360, 260, 700);

  const NAV = [
    { id:"board",     icon:"🗂", label:"Board" },
    { id:"tasks",     icon:"✓",  label:"Tasks" },
    { id:"pipeline",  icon:"▽",  label:"Pipeline" },
    { id:"documents", icon:"📄", label:"Documents" },
    { id:"sellers",   icon:"◆",  label:"Sellers" },
    { id:"buyers",    icon:"◇",  label:"Buyers" },
    { id:"people",    icon:"👥", label:"People" },
    { id:"calendar",  icon:"📅", label:"Calendar" },
    { id:"journal",   icon:"📓", label:"Journal" },
    { id:"archive",   icon:"🗄", label:"Archive" },
    { id:"admin",     icon:"⚙",  label:"Admin" },
  ];

  if (!state.loaded) {
    return (
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12, background:C.bg, fontFamily:"system-ui, sans-serif" }}>
        <div style={{ fontSize:24, fontWeight:700 }}><span style={{ color:C.teal }}>Deal</span>Orchestra</div>
        <div style={{ fontSize:12, color:C.textMuted }}>Loading…</div>
        {loadError && <div style={{ fontSize:11, color:C.red, maxWidth:400, textAlign:"center" }}>{loadError}</div>}
      </div>
    );
  }

  return (
    <div style={{ display:"flex", height:"100vh", fontFamily:"system-ui, -apple-system, sans-serif", background:C.bg, overflow:"hidden" }}>
      {/* Sidebar */}
      <div style={{ width: sidebarCollapsed ? 48 : 200,
        background: darkTheme ? C.sidebar : "#f7f4f2",
        borderRight:`1px solid ${darkTheme ? C.sidebarBorder : C.borderLight}`,
        display:"flex", flexDirection:"column", flexShrink:0, transition:"width 0.18s ease", overflow:"hidden" }}>
        {/* Logo row */}
        <div style={{ padding: sidebarCollapsed ? "14px 0" : "18px 16px 14px",
          borderBottom:`1px solid ${darkTheme ? C.sidebarBorder : C.borderLight}`,
          display:"flex", alignItems:"center", justifyContent: sidebarCollapsed ? "center" : "flex-start", minHeight:60, flexShrink:0 }}>
          {sidebarCollapsed ? (
            <span style={{ fontSize:16, fontWeight:800, color:C.teal }}>D</span>
          ) : (
            <div>
              <div style={{ fontSize:21, fontWeight:800, letterSpacing:-0.5 }}>
                <span style={{ color:C.teal }}>Deal</span>
                <span style={{ color: darkTheme ? "#ffffff" : C.text }}>Orchestra</span>
              </div>
              <div style={{ fontSize:9, color: darkTheme ? C.sidebarMuted : C.textDim, marginTop:2, textTransform:"uppercase", letterSpacing:2 }}>{VERSION} · EasyGold</div>
            </div>
          )}
        </div>

        {/* Search */}
        {!sidebarCollapsed && <UniversalSearch state={state} onNavigate={handleSearchNav} darkTheme={darkTheme} />}

        {/* Nav */}
        <nav style={{ padding:"8px 6px", flex:1, overflowY:"auto" }}>
          {NAV.map(n => {
            const active = view === n.id;
            return (
              <span key={n.id} onClick={() => navigate(n.id)}
                title={sidebarCollapsed ? n.label : undefined}
                style={{
                  display:"flex", alignItems:"center", gap:10, width:"100%",
                  padding: sidebarCollapsed ? "10px 0" : "9px 12px",
                  justifyContent: sidebarCollapsed ? "center" : "flex-start",
                  borderRadius:8, cursor:"pointer", fontSize:12, fontWeight: active ? 600 : 500,
                  background: active ? (darkTheme ? "rgba(42,125,110,0.25)" : C.tealLight) : "transparent",
                  color: active ? C.teal : (darkTheme ? C.sidebarMuted : C.textMuted),
                  borderLeft: (!sidebarCollapsed && active) ? `3px solid ${C.teal}` : "3px solid transparent",
                  marginBottom:1, userSelect:"none", transition:"all 0.1s"
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = darkTheme ? C.sidebarHover : "rgba(0,0,0,0.05)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                <span style={{ fontSize:15, width:20, textAlign:"center", flexShrink:0 }}>{n.icon}</span>
                {!sidebarCollapsed && n.label}
              </span>
            );
          })}
        </nav>

        {/* Footer */}
        <div style={{ padding: sidebarCollapsed ? "6px 0" : "6px 10px",
          borderTop:`1px solid ${darkTheme ? C.sidebarBorder : C.borderLight}`,
          flexShrink:0, display:"flex", alignItems:"center", justifyContent: sidebarCollapsed ? "center" : "space-between", gap:4 }}>
          {!sidebarCollapsed && (
            <div style={{ display:"flex", alignItems:"center", gap:5 }}>
              <span style={{ fontSize:9, color: darkTheme ? C.sidebarMuted : C.textDim }}>🌙</span>
              <div onClick={() => setDarkTheme(v => !v)}
                style={{ width:28, height:16, borderRadius:8,
                  background: darkTheme ? C.teal : C.borderMid,
                  position:"relative", cursor:"pointer", transition:"background 0.2s", flexShrink:0 }}>
                <div style={{ width:12, height:12, background:"white", borderRadius:"50%", position:"absolute",
                  top:2, transform: darkTheme ? "translateX(14px)" : "translateX(2px)", transition:"transform 0.2s" }} />
              </div>
              <span style={{ fontSize:9, color: darkTheme ? C.sidebarMuted : C.textDim }}>Dark</span>
            </div>
          )}
          <span onClick={() => setSidebarCollapsed(v => !v)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{ width:26, height:26, borderRadius:6,
              border:`1px solid ${darkTheme ? C.sidebarBorder : C.borderMid}`,
              display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer",
              fontSize:13, color: darkTheme ? C.sidebarMuted : C.textMuted,
              flexShrink:0, background: darkTheme ? C.sidebarHover : "white", userSelect:"none" }}>
            {sidebarCollapsed ? "›" : "‹"}
          </span>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
        <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
          {view === "board" && (
            <BoardView
              state={state}
              dispatch={dispatch}
              onSelectDeal={(id) => setSelectedDealId(selectedDealId === id ? null : id)}
              initialTab={boardTab}
              onTabChange={(tab) => { setBoardTab(null); if (tab) setLastBoardTab(tab); }}
              onNavigateToTasks={(cardId) => handleSearchNav({ view:"tasks", filterCardId:cardId })}
            />
          )}
          {view === "tasks" && <TasksScreen state={state} dispatch={dispatch} searchNav={view === "tasks" ? searchNav : null} onNavigate={handleSearchNav} />}
          {view === "pipeline" && <PipelineScreen state={state} />}
          {view === "documents" && <DocumentsScreen state={state} dispatch={dispatch} />}
          {view === "sellers" && <SellerRegistryScreen state={state} dispatch={dispatch} searchNav={view === "sellers" ? searchNav : null} onNavigate={handleSearchNav} />}
          {view === "buyers" && <BuyerRegistryScreen state={state} dispatch={dispatch} searchNav={view === "buyers" ? searchNav : null} onNavigate={handleSearchNav} />}
          {view === "people" && <PeopleRegistryScreen state={state} dispatch={dispatch} searchNav={view === "people" ? searchNav : null} />}
          {view === "calendar" && <CalendarScreen state={state} dispatch={dispatch} onNavigate={handleSearchNav} />}
          {view === "journal" && <JournalScreen state={state} dispatch={dispatch} />}
          {view === "archive" && <ArchiveScreen state={state} dispatch={dispatch} />}
          {view === "admin"   && <AdminScreen state={state} />}
        </div>

        {/* Deal panel */}
        {selectedDealId && view === "board" && (
          <DealPanel
            key={`${selectedDealId}-${navKey}-${dealPanelTab||"info"}`}
            dealId={selectedDealId}
            state={state}
            dispatch={dispatch}
            onClose={() => { setSelectedDealId(null); setDealPanelTab(null); }}
            width={dealPanelWidth}
            onDragWidth={onDragDealPanel}
            initialTab={dealPanelTab}
            searchNoteId={searchNoteId}
            searchNoteQuery={searchNoteQuery}
            onNavigateToTasks={(cardId) => handleSearchNav({ view:"tasks", filterCardId:cardId })}
            onQualified={(dealId) => {
              setBoardTab("potential");
              setSelectedDealId(dealId);
              setNavKey(k => k + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}
