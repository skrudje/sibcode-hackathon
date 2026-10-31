import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Check, CircleAlert, Clock3, LoaderCircle, Plus, RefreshCw, Settings2, ShieldCheck, Users } from "lucide-react";
import { api, type Schema, when } from "../api";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { HelpTip } from "./ui/help-tip";

type Connection = Schema<"IntegrationInfo">;
type User = Schema<"User">;
export function Failure({ error }: { error: unknown }) {
  return error ? <div className="notice notice-error" role="alert"><CircleAlert size={16} />{error instanceof Error ? error.message : "Не удалось выполнить действие"}</div> : null;
}
export function useConnections() {
  return useQuery({ queryKey: ["connections"], queryFn: () => api<Schema<"IntegrationPage">>("/integrations"), refetchInterval: 10_000 });
}

export function Integrations({ user }: { user: User }) {
  const client = useQueryClient();
  const connections = useConnections();
  const [selected, setSelected] = useState<Connection | null>(null);
  const [adding, setAdding] = useState(false);
  const [team, setTeam] = useState(false);
  const admin = user.role === "admin";
  const sync = useMutation({ mutationFn: (id: string) => api(`/sources/${id}/sync`, { method: "POST" }), onSuccess: () => void client.invalidateQueries() });
  return <>
    <div className="page-heading"><div><h1>Интеграции</h1><p>Один формат для всех арендаторов. Записи поступают по расписанию, без ручных выгрузок.</p></div><div className="heading-actions">{admin && <><Button variant="outline" onClick={() => setTeam(true)}><Users size={16} />Сотрудники</Button><Button onClick={() => setAdding(true)}><Plus size={16} />Добавить арендатора</Button></>}</div></div>
    <div className="integration-explainer"><span className="integration-symbol"><Cable size={24} /></span><div><strong>API арендатора → автоматическая загрузка → профиль клиента</strong><p>Получаем только телефон, email и время взаимодействия. Достаточно одного корректного контакта. Администратор настраивает подключение один раз, платформа забирает новые записи сама.</p></div><Link className="text-link" to="/sources">Загрузить файл вручную</Link></div>
    <Failure error={connections.error ?? sync.error} />
    {sync.isSuccess && <div className="notice" role="status"><Check size={16} />Загрузка поставлена в очередь. Результат появится в журнале источников.</div>}
    <section className="panel"><div className="panel-heading"><div><h2>Подключения арендаторов <HelpTip term="Источник" /></h2><p>{connections.data?.total ?? "—"} подключений · автоматизация и свежесть данных</p></div></div><div className="table-wrap"><table><thead><tr><th>Арендатор</th><th>Получение данных</th><th>Последняя загрузка</th><th>Полнота истории <HelpTip term="Полнота истории" /></th><th>Действия</th></tr></thead><tbody>{connections.data?.items.map(item => <tr key={item.id}><td><strong>{item.tenant_name}</strong><small>{item.category}</small></td><td><span className={`badge badge-${item.enabled ? "green" : "gray"}`}>{item.enabled ? <><Clock3 size={12} />Каждые {item.interval_minutes} мин.</> : item.has_api ? "По запросу" : "Файлы CSV / Excel"}</span>{item.enabled && <small>Следующая: {when(item.next_sync_at)}</small>}{item.last_error && <small className="red-text">{item.last_error}</small>}</td><td>{when(item.last_success_at)}</td><td>{item.coverage_from && item.coverage_to ? <><span>{when(item.coverage_from)}</span><small>по {when(item.coverage_to)}</small></> : <span className="muted">Период не указан</span>}</td><td><div className="integration-actions">{item.has_api && <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate(item.id)}><RefreshCw size={13} />Обновить</Button>}{admin && <Button size="sm" variant="ghost" aria-label={`Настроить ${item.tenant_name}`} onClick={() => setSelected(item)}><Settings2 size={15} /></Button>}</div></td></tr>)}</tbody></table></div>{connections.isPending && <div className="loading"><LoaderCircle className="spin" size={20} />Загружаем подключения…</div>}</section>
    {!admin && <div className="notice"><ShieldCheck size={16} />Адреса API, расписания и доступы настраивает администратор. Вы можете проверять состояние и запускать обновление данных.</div>}
    {selected && <ConnectionForm key={selected.id} connection={selected} onClose={() => setSelected(null)} />}
    {adding && <TenantForm onClose={() => setAdding(false)} />}
    {team && <TeamDialog user={user} onClose={() => setTeam(false)} />}
  </>;
}

function local(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function ConnectionForm({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const client = useQueryClient();
  const [url, setUrl] = useState(connection.api_url ?? "");
  const [interval, setInterval] = useState(connection.interval_minutes);
  const [enabled, setEnabled] = useState(connection.enabled);
  const [secret, setSecret] = useState(connection.credential_env ?? "");
  const [from, setFrom] = useState(local(connection.coverage_from));
  const [to, setTo] = useState(local(connection.coverage_to));
  const [testing, setTesting] = useState(false);
  const save = useMutation({ mutationFn: async (test: boolean) => {
    if (!!from !== !!to) throw new Error("Укажите обе границы периода либо оставьте обе пустыми");
    await api(`/integrations/${connection.id}`, { method: "PATCH", body: JSON.stringify({ api_url: url, interval_minutes: interval, enabled, credential_env: secret || null, coverage_from: from ? new Date(from).toISOString() : null, coverage_to: to ? new Date(to).toISOString() : null }) });
    if (test) return api<Schema<"ConnectionTest">>(`/integrations/${connection.id}/test`, { method: "POST" });
    return null;
  }, onSuccess: async (_, test) => { await client.invalidateQueries(); if (!test) onClose(); } });
  return <Dialog title={`Подключение · ${connection.tenant_name}`} onClose={() => !save.isPending && onClose()}><form className="dialog-body integration-form" onSubmit={event => { event.preventDefault(); setTesting(false); save.mutate(false); }}>
    <div className="notice"><Cable size={17} />API возвращает записи с тремя полями: phone, email, time. Телефон или email может быть пустым, если указан другой контакт.</div>
    <label>Адрес API<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://api.tenant.ru/interactions" /></label>
    <small>Администратор сервера разрешает домен подключения. Запросы выполняются сервером платформы.</small>
    <div className="form-grid"><label>Интервал, минут<input type="number" min={1} max={1440} required value={interval} onChange={event => setInterval(Number(event.target.value))} /></label><label>Секрет доступа, если требуется<input value={secret} onChange={event => setSecret(event.target.value)} placeholder="Имя сохранённого секрета" /></label></div>
    <small>Секрет заранее настраивается на сервере. Его значение не передаётся в приложение.</small>
    <label className="check-label"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Получать новые записи автоматически</label>
    <div className="integration-coverage"><h3>Полнота истории <HelpTip term="Полнота истории" /></h3><p>Заполняйте только период, за который арендатор гарантирует все взаимодействия. Без такой гарантии оставьте поля пустыми.</p><div className="form-grid"><label>Начало периода<input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label><label>Окончание периода<input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></label></div><small>Время в часовом поясе этого компьютера. API также может явно передавать гарантированный период.</small></div>
    <details><summary>Контракт API и единый формат файлов</summary><pre>{'{\n  "records": [{"phone": "+79131234567", "email": null, "time": "2026-10-30T12:00:00+07:00"}],\n  "next_cursor": "next-position",\n  "has_more": false\n}'}</pre><p>Платформа передаст cursor при следующем запросе. Поля coverage_from и coverage_to в ответе задают гарантированную полноту явно. CSV и Excel используют колонки phone, email, time.</p></details>
    <Failure error={save.error} />{testing && save.isSuccess && <div className="notice" role="status"><Check size={16} />{save.data?.message}</div>}
    <div className="form-actions"><Button type="button" variant="outline" disabled={save.isPending || !url} onClick={() => { setTesting(true); save.mutate(true); }}>{save.isPending && testing ? <LoaderCircle size={15} className="spin" /> : <Cable size={15} />}Сохранить и проверить</Button><Button disabled={save.isPending}>{save.isPending && !testing && <LoaderCircle size={15} className="spin" />}Сохранить</Button></div>
  </form></Dialog>;
}

function TenantForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState(""); const [category, setCategory] = useState("");
  const add = useMutation({ mutationFn: () => api("/tenants", { method: "POST", body: JSON.stringify({ name, category }) }), onSuccess: async () => { await client.invalidateQueries(); onClose(); } });
  return <Dialog title="Новый арендатор" onClose={onClose}><form className="dialog-body" onSubmit={event => { event.preventDefault(); add.mutate(); }}><label>Название<input required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label><label>Категория<input required maxLength={80} value={category} onChange={event => setCategory(event.target.value)} placeholder="Например: спорт, книги, кафе" /></label><p>Подключение создастся автоматически. Затем можно настроить API или загрузить файл с контактами и временем.</p><Failure error={add.error} /><div className="form-actions"><Button type="button" variant="outline" onClick={onClose}>Отмена</Button><Button disabled={add.isPending}>Добавить арендатора</Button></div></form></Dialog>;
}

function TeamDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const client = useQueryClient();
  const members = useQuery({ queryKey: ["team"], queryFn: () => api<Schema<"TeamPage">>("/team") });
  const connections = useConnections();
  const tenants = connections.data?.items.filter(item => item.kind === "contacts") ?? [];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Schema<"TeamMember">["role"]>("marketer");
  const [tenantId, setTenantId] = useState("");
  const add = useMutation({ mutationFn: () => api("/team", { method: "POST", body: JSON.stringify({ email, password, role, tenant_id: role === "brand" ? tenantId : null }) }),
    onSuccess: () => { setEmail(""); setPassword(""); void client.invalidateQueries({ queryKey: ["team"] }); } });
  const update = useMutation({ mutationFn: (member: Schema<"TeamMember">) => api(`/team/${member.id}`, { method: "PATCH", body: JSON.stringify({ role: member.role, is_active: member.is_active, tenant_id: member.role === "brand" ? member.tenant_id : null }) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["team"] }) });
  return <Dialog title="Сотрудники и доступ" onClose={onClose}><div className="dialog-body">
    <p>Маркетолог работает с клиентами и кампаниями. Администратор также управляет подключениями и доступами. Представитель бренда передаёт таблицы только своего магазина через отдельный кабинет.</p>
    <Failure error={members.error ?? connections.error ?? add.error ?? update.error} />
    <div className="team-list">{members.data?.items.map(member => <TeamMemberEditor key={`${member.id}:${member.role}:${member.tenant_id}:${member.is_active}`} member={member}
      own={member.id === user.id} tenants={tenants} busy={update.isPending} onSave={value => update.mutate(value)} />)}</div>
    <form className="team-create" onSubmit={event => { event.preventDefault(); add.mutate(); }}><h3>Добавить сотрудника</h3>
      <label>Email<input type="email" required autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>Первый пароль · от 12 символов<input type="password" minLength={12} required autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <label>Роль<select aria-label="Роль" value={role} onChange={event => setRole(event.target.value as Schema<"TeamMember">["role"])}><option value="marketer">Маркетолог</option><option value="admin">Администратор</option><option value="brand">Представитель бренда</option></select></label>
      {role === "brand" && <label>Магазин представителя<select required value={tenantId} onChange={event => setTenantId(event.target.value)}><option value="">Выберите магазин</option>{tenants.map(tenant => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.tenant_name}</option>)}</select><small>Доступ ограничивается этим магазином. Подходят источники с единым форматом контактов.</small></label>}
      <Button disabled={add.isPending || role === "brand" && !tenantId}>Создать доступ</Button>
    </form></div></Dialog>;
}

function TeamMemberEditor({ member, own, tenants, busy, onSave }: {
  member: Schema<"TeamMember">; own: boolean; tenants: Connection[]; busy: boolean; onSave: (member: Schema<"TeamMember">) => void;
}) {
  const [role, setRole] = useState(member.role);
  const [tenantId, setTenantId] = useState(member.tenant_id ?? "");
  const [active, setActive] = useState(member.is_active);
  const nextTenant = role === "brand" ? tenantId : null;
  const changed = role !== member.role || active !== member.is_active || nextTenant !== member.tenant_id;
  return <form className="team-member" onSubmit={event => { event.preventDefault(); onSave({ ...member, role, is_active: active, tenant_id: nextTenant }); }}>
    <strong>{member.email}</strong>
    <select aria-label={`Роль ${member.email}`} disabled={own || busy} value={role} onChange={event => setRole(event.target.value as Schema<"TeamMember">["role"])}><option value="marketer">Маркетолог</option><option value="admin">Администратор</option><option value="brand">Представитель бренда</option></select>
    {role === "brand" && <select className="team-tenant" required aria-label={`Магазин ${member.email}`} disabled={own || busy} value={tenantId} onChange={event => setTenantId(event.target.value)}><option value="">Выберите магазин</option>{tenants.map(tenant => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.tenant_name}</option>)}</select>}
    <label className="team-active"><input type="checkbox" disabled={own || busy} checked={active} onChange={event => setActive(event.target.checked)} />Доступ</label>
    <Button size="sm" variant="outline" disabled={own || busy || !changed || role === "brand" && !tenantId}>Сохранить</Button>
  </form>;
}
