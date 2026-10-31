import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, CircleAlert, LoaderCircle, Radar as RadarIcon, Send, ShieldCheck, Users } from "lucide-react";
import { api, type Schema, eventNames, number, when } from "../api";
import { Button } from "./ui/button";
import { HelpTip } from "./ui/help-tip";
import "../radar.css";

type Opportunity = Schema<"RadarOpportunity">;
type Options = { lookback_days: number; min_shared_customers: number; min_lift: number };
const defaults: Options = { lookback_days: 90, min_shared_customers: 3, min_lift: 1.1 };
const percent = (value: number) => new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 1 }).format(value);
const decimal = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
const label = (item: Opportunity) => `${item.origins.map(n => n.name).join(" + ")} → ${item.destination.name}`;
const coverageNames = { ready: "История полная", not_loaded: "Нет загрузки", incomplete_history: "Недостаточно истории", no_event_types: "Не заявлены типы событий" };
function queryString(options: Options) { return new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)])).toString(); }
function ErrorNotice({ error }: { error: unknown }) {
  return error ? <div className="notice notice-error" role="alert"><CircleAlert size={16} /><span>{error instanceof Error ? error.message : "Не удалось загрузить радар"}</span></div> : null;
}

export function VisitRadar() {
  const navigate = useNavigate();
  const [options, setOptions] = useState(defaults);
  const [selected, setSelected] = useState("");
  const [offset, setOffset] = useState(0);
  const query = queryString(options);
  const report = useQuery({ queryKey: ["radar", options], queryFn: () => api<Schema<"RadarReport">>(`/radar?${query}`), refetchInterval: 10_000 });
  const items = report.data?.opportunities ?? [];
  const chosen = items.find(item => item.id === selected) ?? items[0];
  useEffect(() => {
    if (chosen && chosen.id !== selected) setSelected(chosen.id);
  }, [chosen?.id, selected]);
  useEffect(() => { setOffset(0); }, [chosen?.id]);
  const audience = useQuery({ queryKey: ["radar-audience", chosen?.id, options, offset], enabled: !!chosen,
    queryFn: () => api<Schema<"RadarAudience">>(`/radar/opportunities/${chosen!.id}?${query}&limit=10&offset=${offset}`), refetchInterval: 10_000 });
  const incomplete = report.data?.nodes.filter(node => node.coverage_status !== "ready") ?? [];
  function choose(id: string) { setSelected(id); setOffset(0); }
  return (
    <>
      <div className="page-heading">
        <div><h1>Радар новых визитов</h1><p>Наблюдаемые связи арендаторов → проверенная аудитория → кампания</p></div>

      </div>
      <div className="radar-toolbar">
        <label><span>Окно истории <HelpTip term="Окно истории" text="Сколько дней до общего среза учитывать при сравнении клиентов. Полнота истории всех участвующих источников должна покрывать этот период." /></span><select aria-label="Окно истории" value={options.lookback_days} onChange={event => { setOptions({ ...options, lookback_days: Number(event.target.value) }); setOffset(0); }}>
          <option value={30}>30 дней</option><option value={90}>90 дней</option><option value={180}>180 дней</option>
        </select></label>
        <label><span>Общих клиентов, минимум <HelpTip term="Общие клиенты" /></span><select aria-label="Общих клиентов, минимум" value={options.min_shared_customers} onChange={event => { setOptions({ ...options, min_shared_customers: Number(event.target.value) }); setOffset(0); }}>
          <option value={3}>3 клиента</option><option value={5}>5 клиентов</option><option value={10}>10 клиентов</option><option value={25}>25 клиентов</option>
        </select></label>
        <label><span>Отношение частот, минимум <HelpTip term="Отношение частот" /></span><select aria-label="Отношение частот, минимум" value={options.min_lift} onChange={event => { setOptions({ ...options, min_lift: Number(event.target.value) }); setOffset(0); }}>
          <option value={1.1}>1,1×</option><option value={1.5}>1,5×</option><option value={2}>2×</option>
        </select></label>
        <span className="radar-updated">{report.isFetching ? <><LoaderCircle size={12} className="spin" /> Пересчёт…</> : <>Обновлено: {when(report.data?.evaluated_at)}</>}</span>
      </div>
      <ErrorNotice error={report.error} />
      <div className="radar-summary">
        <span><strong>{number(report.data?.total_opportunity_count ?? 0)}</strong> возможностей</span>
        <span><strong>{number(report.data?.verified_customer_count ?? 0)}</strong> профилей с контактами</span>
        <span><strong>{number(report.data?.unknown_customer_count ?? 0)}</strong> без контактов · вне расчёта</span>
      </div>
      {incomplete.length > 0 && <div className="notice"><ShieldCheck size={16} /><span>Возможности требуют полной истории за выбранное окно. {incomplete.map(node => `${node.name}: ${coverageNames[node.coverage_status].toLowerCase()}`).join("; ")}. <Link className="text-link" to="/sources">Проверить источники <ArrowRight size={12} /></Link></span></div>}
      <div className="radar-workspace">
        <div className="radar-explorer">
          <section className="panel radar-map-panel">
            <div className="panel-heading"><div><h2>Карта связей арендаторов</h2><p>Выберите связь на карте или в списке ниже</p></div><RadarIcon size={17} className="muted" /></div>
            {report.isPending ? <div className="loading"><LoaderCircle className="spin" size={20} /> Считаем связи…</div> : <RadarMap nodes={report.data?.nodes ?? []} items={items} chosen={chosen} onChoose={choose} />}
            <div className="radar-map-note"><i className="dot dot-blue" /> Связи показывают совместные события за окно истории. Физический маршрут посетителя не отслеживается.</div>
          </section>
          <section className="panel">
            <div className="panel-heading"><div><h2>Возможности для приглашения</h2><p>По убыванию отношения частот · максимум 100 результатов</p></div><span className="badge badge-gray">{items.length}</span></div>
            {items.length ? <div className="radar-opportunities">{items.map(item => <button key={item.id} className={`radar-opportunity${chosen?.id === item.id ? " selected" : ""}`} aria-label={label(item)} aria-pressed={chosen?.id === item.id} onClick={() => choose(item.id)}>
              <span className="radar-opportunity-icon"><ArrowUpRight size={17} /></span><span className="radar-opportunity-name"><strong>{label(item)}</strong><small>{item.shared_count} из {item.cohort_count} уже взаимодействовали · {item.offers.length ? "Есть действующее предложение" : "Нужно предложение"}</small></span><span className="radar-opportunity-numbers"><strong>{decimal(item.lift)}×</strong><small>{item.candidate_count} в аудитории</small></span>
            </button>)}</div> : <div className="empty"><div className="empty-icon"><RadarIcon size={23} /></div><h3>Пока нет подтверждённых возможностей</h3><p>{report.data?.empty_reason === "no_data" ? "Настройте API арендаторов или загрузите CSV / Excel в источниках." : report.data?.empty_reason === "insufficient_history" ? "Для сравнения требуется полная история участвующих источников за общее окно." : "С текущими порогами нет связей с достаточным числом общих клиентов и новой аудиторией."}</p></div>}
          </section>

        </div>
        <aside className="panel radar-inspector" aria-label="Проверка возможности">
          {chosen ? <>
            <div className="panel-heading"><div><span className="radar-kicker">ВОЗМОЖНОСТЬ ДЛЯ ПРИГЛАШЕНИЯ</span><h2>{chosen.destination.name}</h2><p>Из: {chosen.origins.map(node => node.name).join(" + ")}</p></div></div>
            <div className="radar-inspector-body">
              <div className="radar-result"><div><strong>{chosen.candidate_count}</strong><span>клиентов в аудитории <HelpTip term="Новая аудитория" /></span></div><Users size={25} /></div>
              <div className="radar-comparison"><div><span>В выбранной группе</span><strong>{percent(chosen.conditional_rate)}</strong><small>{chosen.shared_count} из {chosen.cohort_count}</small></div><div><span>В общей активной базе</span><strong>{percent(chosen.baseline_rate)}</strong><small>{chosen.destination_count} из {chosen.population_count}</small></div></div>
              <div className="radar-lift"><strong>{decimal(chosen.lift)}×</strong><span>отношение наблюдаемых частот. Связь требует проверки в кампании; это не вероятность покупки.</span></div>
              <details className="radar-explanation"><summary>Как получен результат</summary><p>{chosen.explanation}</p><p>Единица расчёта — уникальный клиент. Повторные взаимодействия не увеличивают число общих клиентов.</p></details>
              <div className="radar-coverage"><ShieldCheck size={16} /><div><strong>Полнота истории заявлена источниками <HelpTip term="Полнота истории" /></strong><small>{when(chosen.window_start)} — {when(chosen.as_of)} · КРСК</small><small>У кандидатов нет зарегистрированного взаимодействия в {chosen.destination.name} за это окно.</small></div></div>
              <div className="radar-audience-heading"><h3>Проверить клиентов</h3><span>{audience.data?.total ?? "—"}</span></div>
              <ErrorNotice error={audience.error} />
              {audience.isPending ? <div className="loading"><LoaderCircle size={17} className="spin" /> Проверяем события…</div> : <div className="radar-customers">{audience.data?.items.map(customer => <details key={customer.id}><summary><span><strong>{customer.display_name ?? "Без имени"}</strong><code>{customer.global_customer_key ?? "Без ключа"}</code></span><span className="radar-evidence-count">{customer.observed_events.length} события</span></summary><div className="radar-customer-evidence">{customer.observed_events.map(event => <p key={event.event_id}><span>{chosen.origins.find(n => n.tenant_id === event.tenant_id)?.name} · {eventNames[event.event_type]}</span><small>{when(event.occurred_at)}</small></p>)}<Link className="text-link" to={`/customers/${customer.id}`}>Открыть профиль <ArrowUpRight size={12} /></Link></div></details>)}</div>}
              {audience.data && audience.data.total > 10 && <div className="pagination radar-pagination"><span>{offset+1}–{Math.min(offset+10, audience.data.total)} из {audience.data.total}</span><div><Button size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(offset-10)}>Назад</Button><Button size="sm" variant="outline" disabled={offset+10 >= audience.data.total} onClick={() => setOffset(offset+10)}>Далее</Button></div></div>}
              {!!audience.data?.shared_examples.length && <details className="radar-explanation"><summary>События, подтверждающие связь</summary><p>Примеры клиентов из {chosen.shared_count} с событиями в исходных местах и взаимодействием с целевым арендатором:</p>{audience.data.shared_examples.map(c => <div key={c.id} className="radar-shared-example"><Link to={`/customers/${c.id}`}>{c.global_customer_key} <ArrowUpRight size={11} /></Link>{c.observed_events.map(e => <small key={e.event_id}>{[...chosen.origins, chosen.destination].find(n => n.tenant_id === e.tenant_id)?.name}: {eventNames[e.event_type]} · {when(e.occurred_at)}</small>)}</div>)}</details>}
              {chosen.offers.length ? <div className="radar-offer"><span className="badge badge-green">Действующее предложение</span><strong>{chosen.offers[0].title}</strong><p>{chosen.offers[0].description}</p><small>До {when(chosen.offers[0].valid_until)}</small></div> : <div className="notice"><CircleAlert size={16} /><span>Для кампании нужно действующее предложение арендатора. <Link className="text-link" to="/recommendations">Открыть рекомендации</Link></span></div>}
            </div>
            <div className="radar-inspector-actions"><Button className="full" disabled={!chosen.offers.length || !audience.data || !!audience.error} onClick={() => navigate(`/campaigns/new?opportunity=${chosen.id}&${query}`)}><Send size={15} /> Создать кампанию из возможности</Button><p className="radar-disclaimer">Перед CSV-выгрузкой контакты проверяются на конфликты, повторы и ограничения частоты.</p></div>
          </> : <div className="empty"><div className="empty-icon"><Users size={22} /></div><h3>Выберите возможность</h3><p>Здесь появятся аудитория, события и действующее предложение арендатора.</p></div>}
        </aside>
      </div>
    </>
  );
}

function RadarMap({ nodes, items, chosen, onChoose }: { nodes: Schema<"RadarNode">[]; items: Opportunity[]; chosen?: Opportunity; onChoose: (id: string) => void }) {
  const markerId = useId().replace(/:/g, "");
  const positions = nodes.map((node, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / Math.max(nodes.length, 1);
    return { ...node, x: 450 + (nodes.length === 1 ? 0 : 320 * Math.cos(angle)), y: 270 + (nodes.length === 1 ? 0 : 200 * Math.sin(angle)) };
  });
  const edges = new Map<string, { from: typeof positions[number]; to: typeof positions[number]; item: Opportunity; selected: boolean }>();
  for (const item of (chosen ? [chosen] : items.slice(0,3))) for (const origin of item.origins) {
    const from = positions.find(n => n.tenant_id === origin.tenant_id), to = positions.find(n => n.tenant_id === item.destination.tenant_id);
    const key = `${origin.tenant_id}:${item.destination.tenant_id}`;
    if (from && to && (!edges.has(key) || item.id === chosen?.id)) edges.set(key, { from, to, item, selected: item.id === chosen?.id });
  }
  return <svg viewBox="0 0 900 540" className="radar-map" role="group" aria-label="Связи арендаторов">
    <defs><marker id={`${markerId}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a9bcb3" /></marker><marker id={`${markerId}-active`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#218764" /></marker></defs>
    <circle cx="450" cy="270" r="130" fill="none" stroke="#e8eeeb" strokeDasharray="3 7" />
    <circle cx="450" cy="270" r="68" fill="none" stroke="#eef2f0" />
    {[...edges.values()].sort((a,b) => Number(a.selected)-Number(b.selected)).map(({from,to,item,selected}) => {
      const dx=to.x-from.x,dy=to.y-from.y,distance=Math.hypot(dx,dy), ux=dx/distance,uy=dy/distance;
      const x1=from.x+ux*64,y1=from.y+uy*31,x2=to.x-ux*72,y2=to.y-uy*36;
      const curve=`M ${x1} ${y1} Q ${(x1+x2)/2-uy*24} ${(y1+y2)/2+ux*24} ${x2} ${y2}`;
      return <g key={`${from.tenant_id}:${to.tenant_id}`} role="button" tabIndex={0} aria-label={`Связь ${from.name} → ${to.name}`} className={`radar-map-edge${selected ? " active" : ""}`} onClick={() => onChoose(item.id)} onKeyDown={event => { if(event.key==="Enter" || event.key===" "){event.preventDefault();onChoose(item.id);} }}><title>{label(item)} · {item.candidate_count} клиентов</title><path d={curve} fill="none" stroke="transparent" strokeWidth="20" /><path className="radar-edge-line" d={curve} fill="none" stroke={selected ? "#218764" : "#b8c9c0"} strokeWidth={selected ? 3 : 1.5} markerEnd={`url(#${markerId}-${selected ? "active" : "arrow"})`} /></g>;
    })}
    {positions.map(node => <g key={node.tenant_id} transform={`translate(${node.x-78},${node.y-29})`} className={`radar-map-node${chosen?.destination.tenant_id===node.tenant_id ? " destination" : ""}`}><title>{node.name} · {coverageNames[node.coverage_status]}</title><rect width="156" height="58" rx="7" /><circle cx="18" cy="21" r="4" fill={node.coverage_status === "ready" ? "#369678" : "#c89b51"} /><text x="30" y="25" className="radar-node-name">{node.name.length > 18 ? node.name.slice(0,17)+"…" : node.name}</text><text x="14" y="44" className="radar-node-category">{node.category}</text></g>)}
    {!nodes.length && <text x="350" y="180" textAnchor="middle" className="radar-node-category">Источники ещё не подключены</text>}
  </svg>;
}
