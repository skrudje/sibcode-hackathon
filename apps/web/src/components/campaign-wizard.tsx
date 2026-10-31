import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, CheckCheck, CircleAlert, GitBranch, LoaderCircle, Mail, MessageSquare, Plus, Radar, Send, ShieldCheck, Sparkles, Users } from "lucide-react";
import { allItems, api, ApiError, number, reasonNames, when, type Rule, type Schema, type Segment, type Tenant } from "../api";
import { AudienceSummary, compatibleDestinations } from "./audience-summary";
import { ConditionEditor } from "./condition-editor";
import { Button } from "./ui/button";
import "../campaign-wizard.css";

type Audience = Schema<"WizardAudience">;
type Definition = Schema<"SegmentDefinition">;
type Draft = Schema<"CampaignWizardDraft">;
type OfferDraft = Schema<"WizardOfferDraft">;
type Preview = Schema<"CampaignWizardPreview">;
type Opportunity = Schema<"RadarOpportunity">;
type OfferFields = { title: string; description: string; from: string; until: string; priority: number };
const steps = ["Аудитория", "Предложение", "Проверка"];
const label = (item: Opportunity) => `${item.origins.map(origin => origin.name).join(" + ")} → ${item.destination.name}`;
const localTime = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function Notice({ error }: { error: unknown }) {
  return error ? <div className="notice notice-error" role="alert"><CircleAlert size={17} /><span>{error instanceof Error ? error.message : "Не удалось выполнить запрос"}</span></div> : null;
}

export function CampaignWizard() {
  const navigate = useNavigate(), client = useQueryClient();
  const [params] = useSearchParams();
  const linkedRuleId = params.get("rule") ?? "", linkedOpportunityId = params.get("opportunity") ?? "";
  const cancelTo = linkedOpportunityId ? "/radar" : linkedRuleId ? "/recommendations" : "/campaigns";
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Audience["kind"]>(linkedOpportunityId ? "radar" : "segment");
  const [segmentId, setSegmentId] = useState("");
  const [opportunityId, setOpportunityId] = useState(linkedOpportunityId);
  const [customDefinition, setCustomDefinition] = useState<Definition | null>(null);
  const [customName, setCustomName] = useState("");
  const [targetId, setTargetId] = useState("");
  const [offerKind, setOfferKind] = useState<"existing" | "new" | null>(null);
  const [offerId, setOfferId] = useState(linkedRuleId);
  const [offerDrafts, setOfferDrafts] = useState<Record<string, OfferFields>>({});
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [localError, setLocalError] = useState("");
  const [audienceInfo, setAudienceInfo] = useState<{ signature: string; data: Schema<"WizardAudiencePreview"> } | null>(null);
  const [defaultDates] = useState(() => ({ from: localTime(new Date(Date.now() - 60_000)), until: localTime(new Date(Date.now() + 30 * 86400_000)) }));
  const keys = useRef(new Map<string, string>());
  const wizardTop = useRef<HTMLDivElement>(null);
  useEffect(() => { wizardTop.current?.scrollIntoView({ block: "start" }); }, [step]);
  const segmentsQuery = useQuery({ queryKey: ["wizard-segments"], queryFn: ({ signal }) => allItems<Segment>("/segments", signal) });
  const tenantsQuery = useQuery({ queryKey: ["wizard-tenants"], queryFn: ({ signal }) => allItems<Tenant>("/tenants", signal) });
  const rulesQuery = useQuery({ queryKey: ["wizard-rules"], queryFn: ({ signal }) => allItems<Rule>("/recommendation-rules", signal) });
  const segments = segmentsQuery.data ?? [], tenants = tenantsQuery.data ?? [], rules = rulesQuery.data ?? [];
  const activeTenants = tenants.filter(tenant => tenant.is_active);
  const linkedRule = rules.find(rule => rule.id === linkedRuleId);
  const segment = segments.find(item => item.id === (segmentId || linkedRule?.segment_id || segments[0]?.id));
  const options = {
    lookback_days: Number(params.get("lookback_days") || 90),
    min_shared_customers: Number(params.get("min_shared_customers") || 3),
    min_lift: Number(params.get("min_lift") || 1.1),
  };
  const radarQuery = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)])).toString();
  const radar = useQuery({ queryKey: ["wizard-radar", options], enabled: mode === "radar",
    queryFn: ({ signal }) => api<Schema<"RadarReport">>(`/radar?${radarQuery}`, { signal }), refetchInterval: mode === "radar" && step === 0 ? 10_000 : false });
  const opportunities = radar.data?.opportunities ?? [];
  const opportunity = opportunityId ? opportunities.find(item => item.id === opportunityId) : opportunities[0];
  const defaults = useMemo<Definition>(() => {
    const a = activeTenants.find(tenant => tenant.code === "A") ?? activeTenants[0];
    const b = activeTenants.find(tenant => tenant.code === "B") ?? activeTenants.find(tenant => tenant.id !== a?.id);
    const c = activeTenants.find(tenant => tenant.code === "C") ?? activeTenants.find(tenant => tenant.id !== a?.id && tenant.id !== b?.id);
    return { lookback_days: 90, include_all: [a, b].filter((item): item is Tenant => !!item).map(item => ({ tenant_id: item.id, event_types: ["interaction"] })),
      exclude_any: c ? [{ tenant_id: c.id, event_types: ["interaction"] }] : [], require_verified_identity: true, require_complete_coverage: true };
  }, [tenantsQuery.data]);
  const editedDefinition = customDefinition ?? defaults;
  const definition = mode === "segment" ? segment?.definition : mode === "custom" ? editedDefinition : opportunity?.definition;
  const emptyAudience = { segment_id: null, definition: null, name: null, opportunity_id: null, options: null };
  const audience: Audience | null = mode === "segment" ? (segment ? { ...emptyAudience, kind: "segment", segment_id: segment.id } : null)
    : mode === "custom" ? { ...emptyAudience, kind: "custom", definition: editedDefinition, name: customName.trim() || null }
    : opportunity ? { ...emptyAudience, kind: "radar", opportunity_id: opportunity.id, options } : null;
  const audienceSignature = JSON.stringify(audience);
  const audienceResult = audienceInfo?.signature === audienceSignature ? audienceInfo.data : null;
  const destinations = compatibleDestinations(definition, activeTenants);
  const destination = destinations.find(item => item.id === targetId) ?? (destinations.length === 1 ? destinations[0] : undefined);
  const offerPreference = (rule: Rule) => mode === "segment" && rule.segment_id === segment?.id ? rule.id === linkedRuleId ? 2 : 1 : 0;
  const offers = rules.filter(rule => rule.destination_tenant_id === destination?.id && rule.is_active && Date.parse(rule.valid_from) <= Date.now() && Date.parse(rule.valid_until) > Date.now())
    .sort((a, b) => offerPreference(b) - offerPreference(a))
    .filter((rule, index, list) => list.findIndex(item => item.offer_title === rule.offer_title && item.offer_description === rule.offer_description && item.valid_from === rule.valid_from && item.valid_until === rule.valid_until) === index);
  const selectedOffer = offers.find(item => item.id === offerId) ?? offers[0];
  const effectiveOfferKind = offerKind ?? (offers.length ? "existing" : "new");
  const fields: OfferFields = destination ? offerDrafts[destination.id] ?? {
    title: `Откройте для себя ${destination.name}`.slice(0, 160), description: "", ...defaultDates, priority: 80,
  } : { title: "", description: "", ...defaultDates, priority: 80 };
  const updateOffer = (patch: Partial<OfferFields>) => destination && setOfferDrafts(value => ({ ...value, [destination.id]: { ...fields, ...patch } }));
  const datesValid = Number.isFinite(Date.parse(fields.from)) && Number.isFinite(Date.parse(fields.until)) && Date.parse(fields.from) < Date.parse(fields.until);
  const newOffer: OfferDraft | null = destination && datesValid && fields.title.trim() ? {
    destination_tenant_id: destination.id, title: fields.title.trim(), description: fields.description,
    valid_from: new Date(fields.from).toISOString(), valid_until: new Date(fields.until).toISOString(), priority: fields.priority,
  } : null;
  const offer: Draft["offer"] | null = effectiveOfferKind === "existing" ? selectedOffer ? { rule_id: selectedOffer.id, draft: null } : null : newOffer ? { rule_id: null, draft: newOffer } : null;
  const rawDraft = audience && offer && name.trim() ? { audience, offer, name: name.trim(), channel } : null;
  const rawSignature = JSON.stringify(rawDraft);
  if (rawDraft && !keys.current.has(rawSignature)) keys.current.set(rawSignature, crypto.randomUUID());
  const draft: Draft | null = rawDraft ? { ...rawDraft, idempotency_key: keys.current.get(rawSignature)! } : null;
  const serialized = JSON.stringify(draft);
  const [debounced, setDebounced] = useState(serialized);
  useEffect(() => { const timer = setTimeout(() => setDebounced(serialized), 300); return () => clearTimeout(timer); }, [serialized]);
  const preview = useQuery({ queryKey: ["wizard-preview", debounced], enabled: step === 2 && debounced !== "null",
    queryFn: ({ signal }) => api<Preview>("/campaigns/preview", { method: "POST", body: debounced, signal }), retry: false });
  const ready = step === 2 && !!draft && serialized === debounced && !!preview.data && !preview.isFetching && !preview.isError;
  const prepare = useMutation({
    mutationFn: () => api<Schema<"CampaignWizardResult">>("/campaigns/prepare", { method: "POST", body: JSON.stringify({ ...draft, preview_token: preview.data?.preview_token }) }),
    onSuccess: async result => { await client.invalidateQueries(); navigate(`/campaigns?campaign=${result.campaign_id}`); },
    onError: error => { if (error instanceof ApiError && error.code === "wizard_preview_changed") void preview.refetch(); },
  });
  const checkAudience = useMutation({
    mutationFn: (body: Audience) => api<Schema<"WizardAudiencePreview">>("/campaigns/audience-preview", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data, body) => {
      setAudienceInfo({ signature: JSON.stringify(body), data });
      const available = compatibleDestinations(data.definition, activeTenants);
      const preferred = body.kind === "radar" ? opportunity?.destination.tenant_id : linkedRule?.segment_id === body.segment_id ? linkedRule?.destination_tenant_id : undefined;
      const chosen = available.find(item => item.id === targetId) ?? available.find(item => item.id === preferred) ?? (available.length === 1 ? available[0] : undefined);
      if (chosen?.id !== destination?.id) { setOfferKind(null); setOfferId(""); }
      setTargetId(chosen?.id ?? ""); setStep(1);
    },
  });
  const useCustom = () => { if (definition) { setCustomDefinition(structuredClone(definition)); setCustomName(mode === "segment" ? `${segment?.name ?? "Аудитория"}`.slice(0, 110) + " · копия" : ""); setMode("custom"); } };
  const changeTarget = (id: string) => { setTargetId(id); setOfferId(""); setOfferKind(null); };
  const pending = prepare.isPending || checkAudience.isPending;
  const audienceName = audienceResult?.name ?? (mode === "segment" ? segment?.name : mode === "radar" ? opportunity && label(opportunity) : customName || "Свои условия");
  const submit = () => {
    setLocalError("");
    if (step === 0 && audience) checkAudience.mutate(audience);
    else if (step === 1 && destination && offer) {
      if (!nameEdited) setName(`${mode === "radar" ? "Радар" : "Приглашение"} · ${destination.name}`.slice(0, 120));
      setStep(2);
    } else if (step === 1) setLocalError("Выберите назначение и заполните корректное предложение.");
    else if (ready && preview.data?.eligible_count) prepare.mutate();
  };

  return <div className="campaign-wizard" ref={wizardTop}>
    <div className="wizard-heading"><div><Link className="wizard-back" to={cancelTo}><ArrowLeft size={14} /> Назад к {linkedOpportunityId ? "радару" : linkedRuleId ? "рекомендациям" : "кампаниям"}</Link>
      <h1>Создать кампанию</h1><p>От подходящей аудитории до готового списка контактов</p></div><span className="badge badge-green"><ShieldCheck size={13} /> Без отправки сообщений</span></div>
    <nav className="wizard-steps" aria-label="Шаги создания кампании">{steps.map((item, index) => <button type="button" key={item}
      className={`wizard-step ${step === index ? "current" : step > index ? "completed" : ""}`} aria-current={step === index ? "step" : undefined}
      disabled={index > step || pending} onClick={() => { if (index < step) { setStep(index); setLocalError(""); } }}>
      <span className="wizard-step-number">{step > index ? <Check size={16} /> : index + 1}</span><span>{item}</span><small>{["Кого приглашаем", "Что предлагаем", "Канал и контакты"][index]}</small>
    </button>)}</nav>
    <Notice error={segmentsQuery.error ?? tenantsQuery.error ?? rulesQuery.error} />
    {segmentsQuery.isPending || tenantsQuery.isPending || rulesQuery.isPending ? <div className="loading"><LoaderCircle className="spin" /> Загружаем аудитории и предложения…</div> : <div className="wizard-layout">
      <section className="panel wizard-panel"><form onSubmit={event => { event.preventDefault(); submit(); }}>
        <fieldset disabled={pending} className="wizard-fields">
          <div className="wizard-section-heading"><span className="wizard-eyebrow">ШАГ {step + 1} ИЗ 3</span><h2>{["Кого приглашаем?", "С каким предложением?", "Всё готово к созданию?"][step]}</h2>
            <p>{["Выберите аудиторию или задайте свои условия отбора.", "Подберите действующее предложение или подготовьте новое.", "Проверьте контакты и итоговые настройки кампании."][step]}</p></div>
          {step === 0 && <>
            <div className="wizard-source-tabs" role="group" aria-label="Источник аудитории">{([
              ["segment", "Готовый сегмент", GitBranch], ["custom", "Новые условия", Plus], ["radar", "Из радара", Radar],
            ] as const).map(([value, title, Icon]) => <button type="button" key={value} className={mode === value ? "selected" : ""} aria-pressed={mode === value} onClick={() => { setMode(value); setLocalError(""); }}><Icon size={17} />{title}</button>)}</div>
            {mode === "segment" && <>
              {segments.length ? <label>Кого приглашаем<select required value={segment?.id ?? ""} onChange={event => setSegmentId(event.target.value)}>{segments.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                : <div className="wizard-empty">Готовых сегментов пока нет. Перейдите в «Новые условия», чтобы собрать первую аудиторию.</div>}
              {definition && <><AudienceSummary title="Условия выбранной аудитории" definition={definition} tenants={tenants} /><Button type="button" variant="ghost" onClick={useCustom}>Создать свою версию условий <ArrowRight size={14} /></Button></>}
            </>}
            {mode === "custom" && <>
              {!activeTenants.length && <div className="wizard-empty">Сначала <Link to="/integrations">добавьте арендаторов</Link> в интеграциях.</div>}
              <label>Название аудитории <span className="wizard-optional">необязательно</span><input maxLength={120} value={customName} onChange={event => setCustomName(event.target.value)} placeholder="Название можно сформировать автоматически" /></label>
              <label>Период истории, дней<input required type="number" min={1} max={365} value={editedDefinition.lookback_days} onChange={event => setCustomDefinition({ ...editedDefinition, lookback_days: Number(event.target.value) })} /></label>
              <ConditionEditor title="Все эти события есть" conditions={editedDefinition.include_all} tenants={activeTenants} onChange={include_all => setCustomDefinition({ ...editedDefinition, include_all })} />
              <ConditionEditor title="Ни одного из этих событий нет" conditions={editedDefinition.exclude_any} tenants={activeTenants} onChange={exclude_any => setCustomDefinition({ ...editedDefinition, exclude_any })} />
              <div className="wizard-help"><ShieldCheck size={17} /><span>В аудиторию попадут клиенты с корректными контактами и полной историей за выбранный период.</span></div>
            </>}
            {mode === "radar" && <>
              <Notice error={radar.error} />
              {radar.isPending ? <div className="loading"><LoaderCircle size={18} className="spin" /> Ищем возможности…</div> : opportunities.length ? <>
                <label>Возможность для приглашения<select required value={opportunity?.id ?? ""} onChange={event => setOpportunityId(event.target.value)}><option value="" disabled>Выберите актуальную возможность</option>{opportunities.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}</select></label>
                {opportunity ? <><div className="wizard-radar-result"><Users size={24} /><div><strong>{number(opportunity.candidate_count)} кандидатов</strong><span>Отношение частот {opportunity.lift.toFixed(2)}× · {options.lookback_days} дней</span></div></div>
                  <AudienceSummary title="Условия из радара" definition={opportunity.definition} tenants={tenants} /><Button type="button" variant="ghost" onClick={useCustom}>Задать свои условия на основе этой возможности <ArrowRight size={14} /></Button></>
                  : <div className="notice">Выбранная возможность уже изменилась. Выберите другую из списка.</div>}
              </> : <div className="wizard-empty">Сейчас подходящих возможностей нет. Можно выбрать готовый сегмент или задать условия вручную.</div>}
            </>}
            <Notice error={checkAudience.error} />
          </>}
          {step === 1 && <>
            {destinations.length === 1 ? <div className="wizard-target"><span>Куда приглашаем</span><strong>{destination?.name}</strong><small>Назначение определено условиями аудитории</small></div>
              : destinations.length > 1 ? <label>Куда приглашаем<select required value={destination?.id ?? ""} onChange={event => changeTarget(event.target.value)}><option value="">Выберите арендатора</option>{destinations.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
                : <div className="notice notice-error" role="alert">У аудитории нет совместимого назначения. Вернитесь на первый шаг и добавьте исключение взаимодействия или покупки у целевого арендатора.</div>}
            {destination && <>
              <div className="wizard-offer-tabs" role="group" aria-label="Источник предложения"><button type="button" className={effectiveOfferKind === "existing" ? "selected" : ""} aria-pressed={effectiveOfferKind === "existing"} disabled={!offers.length} onClick={() => setOfferKind("existing")}><Sparkles size={16} /> Действующее предложение {offers.length ? `(${offers.length})` : ""}</button><button type="button" className={effectiveOfferKind === "new" ? "selected" : ""} aria-pressed={effectiveOfferKind === "new"} onClick={() => setOfferKind("new")}><Plus size={16} /> Новое предложение</button></div>
              {effectiveOfferKind === "existing" ? <>
                <label>Предложение арендатора<select required value={selectedOffer?.id ?? ""} onChange={event => setOfferId(event.target.value)}>{offers.map(item => <option key={item.id} value={item.id}>{item.offer_title}</option>)}</select></label>
                {selectedOffer && <div className="wizard-offer-preview"><span className="badge badge-green">Действует до {when(selectedOffer.valid_until)}</span><h3>{selectedOffer.offer_title}</h3><p>{selectedOffer.offer_description || "Описание не указано"}</p></div>}
              </> : <>
                {!offers.length && <p className="field-hint">У этого арендатора пока нет действующих предложений. Подготовьте новое прямо здесь.</p>}
                <label>Заголовок предложения<input required maxLength={160} value={fields.title} onChange={event => updateOffer({ title: event.target.value })} /></label>
                <label>Описание предложения<textarea rows={3} maxLength={1000} value={fields.description} onChange={event => updateOffer({ description: event.target.value })} placeholder="Условия предложения для клиента" /></label>
                <div className="form-grid"><label>Действует с<input required type="datetime-local" value={fields.from} onChange={event => updateOffer({ from: event.target.value })} /></label><label>Действует до<input required type="datetime-local" value={fields.until} onChange={event => updateOffer({ until: event.target.value })} /></label></div>
                {!datesValid && <div className="notice notice-error">Дата окончания должна быть позже даты начала.</div>}
                <details className="wizard-advanced"><summary>Дополнительные настройки</summary><label>Бизнес-приоритет<input type="number" min={1} max={100} value={fields.priority} onChange={event => updateOffer({ priority: Number(event.target.value) })} /></label><p className="field-hint">Влияет на порядок рекомендаций в карточке клиента. Не является вероятностью покупки.</p></details>
              </>}
            </>}
          </>}
          {step === 2 && <>
            <label>Название кампании<input required maxLength={120} value={name} onChange={event => { setName(event.target.value); setNameEdited(true); }} /></label>
            <fieldset className="wizard-channel"><legend>Канал выгрузки</legend>{([ ["email", "Email", Mail], ["sms", "SMS", MessageSquare] ] as const).map(([value, title, Icon]) => <label key={value} className={channel === value ? "selected" : ""}><input type="radio" name="wizard-channel" value={value} checked={channel === value} onChange={() => setChannel(value)} /><Icon size={19} /><span>{title}</span><small>{value === "email" ? "Адреса электронной почты" : "Телефоны для SMS"}</small></label>)}</fieldset>
            <Notice error={preview.error} />
            {!ready && !preview.error && <div className="wizard-preview-loading"><LoaderCircle className="spin" size={20} /> Проверяем актуальную аудиторию и контакты…</div>}
            {ready && preview.data && <>
              <div className="wizard-counts" aria-label="Результат проверки контактов"><div><span>В аудитории</span><strong>{number(preview.data.base_count)}</strong></div><ArrowRight size={20} /><div className="eligible"><span>Доступны для {channel === "email" ? "Email" : "SMS"}</span><strong>{number(preview.data.eligible_count)}</strong></div><div><span>Исключены</span><strong>{number(preview.data.base_count - preview.data.eligible_count)}</strong></div></div>
              {preview.data.unknown_count > 0 && <p className="field-hint">Ещё {number(preview.data.unknown_count)} профилей не вошли в аудиторию: недостаточно истории или корректных контактов.</p>}
              {Object.values(preview.data.excluded_counts).some(Boolean) && <div className="wizard-exclusions"><strong>Почему часть контактов исключена</strong>{Object.entries(preview.data.excluded_counts).filter(([, count]) => count > 0).map(([reason, count]) => <div key={reason}><span>{reasonNames[reason] ?? reason}</span><strong>{number(count)}</strong></div>)}</div>}
              {!preview.data.eligible_count && <div className="notice notice-error" role="alert">Для этого канала сейчас нет подходящих контактов. Выберите другой канал или измените аудиторию.</div>}
              {!!preview.data.sample.length && <div className="wizard-recipient-sample"><h3>Пример получателей</h3><div className="table-wrap"><table><thead><tr><th>Клиент</th><th>Контакт</th></tr></thead><tbody>{preview.data.sample.slice(0, 8).map(item => <tr key={item.customer_id}><td>{item.display_name ?? "Без имени"}</td><td>{item.contact}</td></tr>)}</tbody></table></div><p className="field-hint">Показаны первые {Math.min(8, preview.data.sample.length)} контактов. Срез: {when(preview.data.as_of)}.</p></div>}
              <div className="wizard-help"><ShieldCheck size={17} /><span>При создании сервер ещё раз проверит аудиторию и предложение. CSV можно сформировать на следующем экране. Сообщения не отправляются.</span></div>
            </>}
            <Notice error={prepare.error} />
          </>}
          <Notice error={localError || null} />
        </fieldset>
        <div className="wizard-actions"><div>{step > 0 ? <Button type="button" variant="outline" disabled={pending} onClick={() => { setStep(step - 1); setLocalError(""); }}><ArrowLeft size={15} /> Назад</Button> : <Button type="button" variant="outline" disabled={pending} onClick={() => navigate(cancelTo)}>Отмена</Button>}</div>
          <Button type="submit" disabled={pending || (step === 0 && (!audience || !activeTenants.length)) || (step === 1 && (!destination || !offer)) || (step === 2 && (!ready || !preview.data?.eligible_count))}>
            {pending ? <LoaderCircle className="spin" size={16} /> : step === 2 ? <CheckCheck size={17} /> : null}
            {step === 0 ? "Далее: предложение" : step === 1 ? "Далее: проверка" : "Создать кампанию"}{step < 2 && <ArrowRight size={16} />}
          </Button>
        </div>
      </form></section>
      <aside className="wizard-summary"><div className="wizard-summary-heading"><Send size={19} /><strong>Ваша кампания</strong></div>
        <div className="wizard-summary-item"><span><Users size={14} /> Кого приглашаем</span><strong>{audienceName || "Выберите аудиторию"}</strong>{audienceResult && <small>{number(audienceResult.eligible_count)} клиентов · {definition?.lookback_days} дней</small>}</div>
        <div className="wizard-summary-item"><span><ArrowRight size={14} /> Куда приглашаем</span><strong>{destination?.name ?? "Определится на втором шаге"}</strong></div>
        <div className="wizard-summary-item"><span><Sparkles size={14} /> Что предлагаем</span><strong>{step > 0 ? effectiveOfferKind === "existing" ? selectedOffer?.offer_title ?? "Выберите предложение" : fields.title || "Заполните предложение" : "Следующий шаг"}</strong></div>
        <div className="wizard-summary-item"><span><Mail size={14} /> Канал</span><strong>{step === 2 ? channel === "email" ? "Email" : "SMS" : "Выберем на третьем шаге"}</strong></div>
        {step === 2 && ready && <div className="wizard-summary-ready"><Check size={18} /><div><strong>{number(preview.data?.eligible_count ?? 0)} контактов</strong><span>доступны для выгрузки</span></div></div>}
        <p>Изменения сохранятся после «Создать кампанию». Готовые аудитории и правила будут использованы повторно, новые — сохранены вместе с кампанией.</p>
      </aside>
    </div>}
  </div>;
}
