import { useEffect, useState, type ReactNode } from "react";
import {
  Link,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronLeft,
  CircleAlert,
  Clapperboard,
  Database,
  Filter,
  GitBranch,
  Link2,
  LoaderCircle,
  Mail,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  type Campaign,
  type Customer,
  type ImportJob,
  type Rule,
  type Schema,
  type Segment,
  type Tenant,
  eventNames,
  number,
  reasonNames,
  useData,
  when,
} from "./api";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { ConnectionUnavailable, DesktopConnection, ExportDownload } from "./components/desktop";
import { Workspace } from "./components/workspace";
import { VisitRadar } from "./components/radar";
import { Integrations } from "./components/integrations";
import { SourceWorkspace } from "./components/source-workspace";
import { AudienceSummary, compatibleDestinations } from "./components/audience-summary";
import { HelpTip } from "./components/ui/help-tip";


function Message({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`notice ${error ? "notice-error" : ""}`}
      role={error ? "alert" : undefined}
    >
      <CircleAlert size={17} />
      <span>{children}</span>
    </div>
  );
}
function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <Message error>
      {error instanceof Error ? error.message : "Не удалось загрузить данные"}
    </Message>
  ) : null;
}
function Loading() {
  return (
    <div className="loading">
      <LoaderCircle className="spin" size={23} />
      <span>Загружаем данные…</span>
    </div>
  );
}
function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Database size={25} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Badge({
  children,
  tone = "gray",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
function Title({
  eyebrow,
  title,
  text,
  actions,
}: {
  eyebrow?: string;
  title: string;
  text: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <div className="heading-with-help"><h1>{title}</h1>{title === "Сегменты" && <HelpTip term="Сегмент" />}</div>
        <p>{text}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}
function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? "avatar-sm" : ""}`}>
      {name.replace("Посетитель ", "П").slice(0, 2).toUpperCase()}
    </span>
  );
}
function IdentityBadge({ status }: { status: string }) {
  return status === "verified" ? (
    <Badge tone="green">
      <ShieldCheck size={12} /> Есть контакты
    </Badge>
  ) : (
    <Badge tone="amber">Нет контактов</Badge>
  );
}
function StatusBadge({ job }: { job: ImportJob }) {
  const labels = {
    queued: "В очереди",
    running: "Обработка",
    succeeded: "Загружен",
    completed_with_errors: "Есть замечания",
    failed: "Ошибка",
  };
  return (
    <Badge
      tone={
        job.status === "succeeded"
          ? "green"
          : job.status === "failed"
            ? "red"
            : job.status === "completed_with_errors"
              ? "amber"
              : "blue"
      }
    >
      {["running", "queued"].includes(job.status) && (
        <LoaderCircle size={12} className="spin" />
      )}
      {labels[job.status]}
    </Badge>
  );
}
function Pagination({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {total
          ? `${offset + 1}–${Math.min(offset + 20, total)} из ${total}`
          : "Нет записей"}
      </span>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={!offset}
          onClick={() => onChange(offset - 20)}
        >
          Назад
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={offset + 20 >= total}
          onClick={() => onChange(offset + 20)}
        >
          Далее
        </Button>
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("marketer@example.com"),
    [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    onSuccess: onLogin,
  });
  return (
    <div className="login-page">
      <main className="login-form">
        <div className="login-mark"><span className="brand-icon"><Link2 size={23} /></span><strong>Хрюкерсы</strong><span>CDP</span></div>
        <h2>Добро пожаловать</h2>
        <p>Войдите в рабочее пространство торгового центра</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="Введите пароль"
            />
          </label>
          <ErrorMessage error={mutation.error} />
          <Button disabled={mutation.isPending} className="full">
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              "Войти в платформу"
            )}
            <ArrowRight size={17} />
          </Button>
        </form>
        <div className="login-note">
          <ShieldCheck size={15} /> Рабочее пространство торгового центра
        </div>
      </main>
      <div className="login-version"><span>Клиентская платформа · SibКод 2026 · 0.1.0</span><DesktopConnection /></div>
    </div>
  );
}

export default function App() {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Schema<"User">>("/auth/me"),
    retry: false,
  });
  useEffect(() => {
    const expired = () => {
      client.clear();
      void me.refetch();
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [client, me.refetch]);
  if (me.isPending) return <Loading />;
  if (!me.data && me.isError && !(me.error instanceof ApiError && me.error.status === 401))
    return <ConnectionUnavailable checking={me.isFetching} onRetry={() => void me.refetch()} />;
  if (!me.data)
    return (
      <Login
        onLogin={() => {
          void client.invalidateQueries({ queryKey: ["me"] });
        }}
      />
    );
  return <Layout user={me.data} />;
}

function Layout({ user }: { user: Schema<"User"> }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [help, setHelp] = useState(false);
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      client.clear();
      client.setQueryData(["me"], null);
      navigate("/", { replace: true });
    },
  });
  return (
    <Workspace email={user.email} role={user.role} onHelp={() => setHelp(true)} onLogout={() => logout.mutate()} loggingOut={logout.isPending}>
      <ErrorMessage error={logout.error} />
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/sources" element={<Sources />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerProfile />} />
        <Route path="/segments" element={<Segments />} />
        <Route path="/recommendations" element={<Recommendations />} />
        <Route path="/campaigns" element={<Campaigns />} />
        <Route path="/radar" element={<VisitRadar />} />
        <Route path="/integrations" element={<Integrations user={user} />} />
        <Route path="*" element={<Empty title="Страница не найдена" text="Выберите раздел в меню слева." />} />
      </Routes>
      {help && (
        <Dialog
          title="От данных — к следующему визиту"
          onClose={() => setHelp(false)}
        >
          <div className="dialog-body">
            <p>
              Платформа объединяет события арендаторов по совпадению
              нормализованного телефона или email внутри ТЦ. Сегменты учитывают
              период наблюдения и полноту доступной истории.
            </p>
            <ol className="help-steps">
              <li>Администратор настраивает API арендаторов в «Интеграциях».</li>
              <li>Платформа по расписанию получает телефон, email и время взаимодействия.</li>
              <li>В профиле видна общая история и происхождение контактов.</li>
              <li>Создайте сегмент вручную или выберите возможность в радаре.</li>
              <li>Проверьте контакты в кампании и сформируйте CSV для внешней системы.</li>
            </ol>
            <Message>Выгрузка не отправляет сообщения. Полнота истории задаётся явно; отсутствие записи не доказывает отсутствие посещения.</Message>
            <Button asChild>
              <Link to="/sources" onClick={() => setHelp(false)}>
                Перейти к источникам
                <ArrowRight size={16} />
              </Link>
            </Button>
          </div>
        </Dialog>
      )}
    </Workspace>
  );
}

function Overview() {
  const summary = useData<Schema<"Summary">>(["summary"], "/summary"),
    sources = useData<Schema<"SourcePage">>(["sources"], "/sources"),
    customers = useData<Schema<"CustomerPage">>(
      ["recent-customers"],
      "/customers?limit=4",
    );
  const data = summary.data;
  return (
    <>
      <Title
        title="Обзор платформы"
        text="Состояние клиентской базы и загрузок ТЦ «Орбита»"
        actions={
          <>
            <Button asChild><Link to="/sources"><Upload size={15} /> Загрузить данные</Link></Button>
            <Button asChild variant="outline"><Link to="/radar"><Sparkles size={15} /> Радар новых визитов</Link></Button>
          </>
        }
      />
      <ErrorMessage error={summary.error} />
      <div className="metrics">
        {[
          {
            label: "Единых профилей",
            value: data?.customer_count,
            icon: Users,
            hint: "Клиенты всех арендаторов",
            tone: "blue",
          },
          {
            label: "Записей в истории",
            value: data?.event_count,
            icon: GitBranch,
            hint: "Записи от арендаторов",
            tone: "purple",
          },
          {
            label: "Профилей с контактами",
            value: data?.verified_customer_count,
            icon: ShieldCheck,
            hint: "Есть корректный телефон или email",
            tone: "green",
          },
          {
            label: "Источников данных",
            value: data?.source_count,
            icon: Database,
            hint: "CRM, касса и REST API",
            tone: "orange",
          },
        ].map(({ label, value, icon: Icon, hint, tone }) => (
          <div className="metric" key={label}>
            <div className="metric-top">
              <span>{label} <HelpTip term={label === "Единых профилей" ? "Профиль" : label === "Профилей с контактами" ? "Есть контакты" : label === "Источников данных" ? "Источник" : "Взаимодействие"} text={label === "Записей в истории" ? "Зафиксированные контакты с арендатором. Новые записи содержат только телефон, email и время; покупку по ним не определяем." : undefined} /></span>
              <span className={`metric-icon ${tone}`}>
                <Icon size={19} />
              </span>
            </div>
            <strong>{value === undefined ? "—" : number(value)}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <Panel
          title="Последние загрузки"
          subtitle="Результаты последних заданий импорта"
          action={
            <Link className="text-link" to="/sources">
              Все источники
              <ArrowRight size={15} />
            </Link>
          }
        >
          {data?.last_imports.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Источник</th>
                    <th>Принято</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {data.last_imports.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <strong>
                          {sources.data?.items.find(
                            (s) => s.id === job.source_id,
                          )?.name ?? "Источник"}
                        </strong>
                        <small>{when(job.created_at)}</small>
                      </td>
                      <td>{job.accepted_rows}</td>
                      <td>
                        <StatusBadge job={job} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : summary.isPending ? (
            <Loading />
          ) : (
            <Empty
              title="История начинается с данных"
              text="Настройте API арендаторов или загрузите файлы с взаимодействиями."
              action={
                <Button variant="outline" asChild>
                  <Link to="/sources">
                    Подключить источники
                    <ArrowRight size={15} />
                  </Link>
                </Button>
              }
            />
          )}
        </Panel>
        <Panel
          title="Качество идентификации"
          subtitle="Сопоставляем по телефону или email внутри ТЦ"
        >
          <div className="quality">
            <div
              className="quality-ring"
              style={
                {
                  "--progress": `${data?.customer_count ? (data.verified_customer_count / data.customer_count) * 100 : 0}%`,
                } as React.CSSProperties
              }
            >
              <div>
                <strong>
                  {data?.customer_count
                    ? Math.round(
                        (data.verified_customer_count / data.customer_count) *
                          100,
                      )
                    : 0}
                  %
                </strong>
                <span>с контактами</span>
              </div>
            </div>
            <div className="legend">
              <div>
                <span>
                  <i className="dot dot-blue" />
                  Телефон или email
                </span>
                <strong>{data?.verified_customer_count ?? 0}</strong>
              </div>
              <div>
                <span>
                  <i className="dot dot-gray" />
                  Без контактов
                </span>
                <strong>{data?.source_only_customer_count ?? 0}</strong>
              </div>
            </div>
            <p>
              Совпадение телефона или email объединяет записи. Если контакты
              указывают на разные профили, импорт сообщает о конфликте.
            </p>
          </div>
        </Panel>
      </div>
      <Panel
        title="Клиенты вашего ТЦ"
        subtitle="Один профиль — события разных арендаторов"
        action={
          <Link className="text-link" to="/customers">
            Все клиенты
            <ArrowRight size={15} />
          </Link>
        }
      >
        {customers.data?.items.length ? (
          <CustomerTable customers={customers.data.items} />
        ) : (
          <div className="inline-empty">
            После первой загрузки здесь появятся профили посетителей.
          </div>
        )}
      </Panel>
    </>
  );
}

function CustomerTable({ customers }: { customers: Customer[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Клиент</th>
            <th>ID профиля</th>
            <th>Идентификация</th>
            <th>Создан</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td>
                <Link to={`/customers/${c.id}`} className="person">
                  <Avatar name={c.display_name ?? "Клиент"} small />
                  <span>
                    <strong>{c.display_name ?? "Без имени"}</strong>
                    <small>Посетитель ТЦ</small>
                  </span>
                </Link>
              </td>
              <td>
                <code>{c.global_customer_key ?? c.id}</code>
              </td>
              <td>
                <IdentityBadge status={c.identity_status} />
              </td>
              <td className="muted">{when(c.created_at)}</td>
              <td>
                <Link
                  to={`/customers/${c.id}`}
                  className="table-link"
                  aria-label={`Открыть ${c.display_name ?? c.global_customer_key ?? "профиль"}`}
                >
                  <ArrowUpRight size={18} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sources() { return <SourceWorkspace />; }

function Customers() {
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [offset, setOffset] = useState(0);
  const data = useData<Schema<"CustomerPage">>(
    ["customers", search, filter, offset],
    `/customers?offset=${offset}&q=${encodeURIComponent(search)}${filter ? `&identity_status=${filter}` : ""}`,
  );
  return (
    <>
      <Title
        title="Клиенты"
        text="Профили посетителей и события из всех источников"
        actions={<Badge tone="blue">{data.data?.total ?? "—"} профилей</Badge>}
      />
      <Panel className="customer-browser">
        <div className="table-toolbar">
          <label className="search-input">
            <Search size={18} />
            <input
              aria-label="Поиск клиентов"
              placeholder="Поиск по имени, телефону, email или ID"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <div className="filter-control">
            <Filter size={16} />
            <select
              aria-label="Идентификация"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">Все профили</option>
              <option value="verified">С телефоном или email</option>
              <option value="source_only">Без контактов</option>
            </select>
          </div>
        </div>
        <ErrorMessage error={data.error} />
        {data.isPending ? (
          <Loading />
        ) : data.data?.items.length ? (
          <>
            <CustomerTable customers={data.data.items} />
            <Pagination
              offset={offset}
              total={data.data.total}
              onChange={setOffset}
            />
          </>
        ) : (
          <Empty
            title="Профили не найдены"
            text="Измените поиск или загрузите данные арендаторов."
          />
        )}
      </Panel>
      <Message>
        Общий клиентский ключ связывает данные источников. Одинаковые имена и
        email сами по себе не доказывают, что это один человек.
      </Message>
    </>
  );
}

function CustomerProfile() {
  const { id } = useParams(),
    [offset, setOffset] = useState(0);
  const profile = useData<Schema<"CustomerDetail">>(
      ["customer", id],
      `/customers/${id}`,
    ),
    events = useData<Schema<"EventPage">>(
      ["events", id, offset],
      `/customers/${id}/events?offset=${offset}`,
    ),
    recs = useData<Schema<"RecommendationResult">>(
      ["recs", id],
      `/customers/${id}/recommendations`,
    ),
    tenants = useData<Schema<"TenantPage">>(["tenants"], "/tenants"),
    sources = useData<Schema<"SourcePage">>(["sources"], "/sources");
  const customer = profile.data;
  if (profile.isPending) return <Loading />;
  if (!customer) return <ErrorMessage error={profile.error} />;
  return (
    <>
      <Link className="back-link" to="/customers">
        <ChevronLeft size={16} />
        Все клиенты
      </Link>
      <div className="profile-heading">
        <Avatar name={customer.display_name ?? "Клиент"} />
        <div>
          <div className="eyebrow">ЕДИНЫЙ ПРОФИЛЬ</div>
          <h1>{customer.display_name ?? "Без имени"}</h1>
          <div className="profile-meta">
            <code>{customer.global_customer_key ?? customer.id}</code>
            <IdentityBadge status={customer.identity_status} />
            <span>
              {customer.event_count} событий ·{" "}
              {customer.external_identities.length} внешних ID
            </span>
          </div>
        </div>
      </div>
      <div className="profile-grid">
        <div>
          <Panel
            title="Лента событий"
            subtitle="Каждое событие — с датой и источником"
          >
            {events.isPending ? (
              <Loading />
            ) : (
              <>
                <div className="timeline">
                  {events.data?.items.map((event) => {
                    const tenant = tenants.data?.items.find(
                      (t) => t.id === event.tenant_id,
                    );
                    const Icon =
                      event.event_type === "purchase"
                        ? BookOpen
                        : event.event_type === "booking"
                          ? Clapperboard
                          : Check;
                    return (
                      <div className="timeline-event" key={event.id}>
                        <div className={`event-icon event-${event.event_type}`}>
                          <Icon size={20} />
                        </div>
                        <div>
                          <div className="timeline-title">
                            <strong>{eventNames[event.event_type]}</strong>
                            <span>
                              {event.amount
                                ? `${number(Number(event.amount))} ₽`
                                : ""}
                            </span>
                          </div>
                          <p>{tenant?.name}</p>
                          <small>
                            {when(event.occurred_at)} ·{" "}
                            {
                              sources.data?.items.find(
                                (s) => s.id === event.source_id,
                              )?.name
                            }
                          </small>
                          <code className="event-id">
                            {event.external_event_id}
                          </code>
                        </div>
                      </div>
                    );
                  })}
                  {!events.data?.total && (
                    <div className="inline-empty">Пока нет событий</div>
                  )}
                </div>
                <Pagination
                  offset={offset}
                  total={events.data?.total ?? 0}
                  onChange={setOffset}
                />
              </>
            )}
          </Panel>
          <Panel
            title="Контакты и происхождение"
            subtitle="Сохраняем различия между источниками"
          >
            {customer.contact_conflicts.length > 0 && (
              <div className="panel-padding">
                <Message error>
                  Конфликт каналов: {customer.contact_conflicts.join(", ")}.
                  Выгрузка по конфликтующему каналу будет исключена.
                </Message>
              </div>
            )}
            <div className="contact-list">
              {customer.contacts.map((contact) => (
                <div key={contact.id}>
                  <span className="contact-icon">
                    <Mail size={17} />
                  </span>
                  <div>
                    <strong>{contact.value}</strong>
                    <small>
                      {contact.channel} ·{" "}
                      {
                        sources.data?.items.find(
                          (s) => s.id === contact.source_id,
                        )?.name
                      }
                    </small>
                  </div>
                  {!contact.normalized_value && (
                    <Badge tone="amber">Проверьте формат</Badge>
                  )}
                </div>
              ))}
              {!customer.contacts.length && (
                <p className="muted">Контакты не переданы источниками.</p>
              )}
            </div>
          </Panel>
        </div>
        <div>
          <Panel
            title="Следующий шаг"
            subtitle="Персональная рекомендация"
            className="recommendation-panel"
          >
            {recs.isPending ? (
              <Loading />
            ) : recs.data?.items.length ? (
              recs.data.items.map((rec) => (
                <div className="recommendation" key={rec.rule_id}>
                  <div className="recommendation-icon">
                    <BookOpen size={29} />
                  </div>
                  <Badge tone="blue">Новое место в доступной истории</Badge>
                  <h2>{rec.destination_tenant_name}</h2>
                  <p className="offer-title">{rec.offer_title}</p>
                  <p>{rec.offer_description}</p>
                  <div className="reason-box">
                    <Sparkles size={17} />
                    <div>
                      <strong>Почему это предложение</strong>
                      <p>{rec.explanation}</p>
                    </div>
                  </div>
                  <span className="muted small">
                    Срез: {when(recs.data?.as_of)} · КРСК
                  </span>
                  <Button asChild className="full">
                    <Link to="/campaigns">
                      Перейти к кампании
                      <ArrowUpRight size={16} />
                    </Link>
                  </Button>
                </div>
              ))
            ) : (
              <div className="recommendation-empty">
                <CheckCheck size={35} />
                <h3>Подходящего предложения пока нет</h3>
                <p>
                  {reasonNames[recs.data?.empty_reason ?? "no_matching_rules"]}
                </p>
              </div>
            )}
            <ErrorMessage error={recs.error} />
          </Panel>
          <Panel title="Связи профиля">
            <div className="identity-list">
              {customer.external_identities.map((identity) => (
                <div
                  key={`${identity.source_id}-${identity.external_customer_id}`}
                >
                  <Link2 size={16} />
                  <div>
                    <strong>
                      {
                        sources.data?.items.find(
                          (s) => s.id === identity.source_id,
                        )?.name
                      }
                    </strong>
                    <code>{identity.external_customer_id}</code>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function ConditionEditor({
  title,
  conditions,
  tenants,
  onChange,
}: {
  title: string;
  conditions: Schema<"EventCondition">[];
  tenants: Tenant[];
  onChange: (conditions: Schema<"EventCondition">[]) => void;
}) {
  return (
    <div className="condition-group">
      <div>
        <strong>{title}</strong>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={conditions.length >= 5}
          onClick={() =>
            onChange([
              ...conditions,
              { tenant_id: tenants[0]?.id ?? "", event_types: ["interaction"] },
            ])
          }
        >
          <Plus size={14} />
          Условие
        </Button>
      </div>
      {conditions.map((condition, i) => (
        <div className="condition-row" key={i}>
          <select
            aria-label={`${title} арендатор ${i + 1}`}
            required
            value={condition.tenant_id}
            onChange={(e) =>
              onChange(
                conditions.map((c, j) =>
                  j === i ? { ...c, tenant_id: e.target.value } : c,
                ),
              )
            }
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className="type-checks">
            {(["interaction", ...condition.event_types.filter(type => type !== "interaction")] as const).map((type) => (
              <label key={type}>
                <input
                  type="checkbox"
                  checked={condition.event_types.includes(type)}
                  onChange={(e) =>
                    onChange(
                      conditions.map((c, j) =>
                        j === i
                          ? {
                              ...c,
                              event_types: e.target.checked
                                ? [...c.event_types, type]
                                : c.event_types.filter((t) => t !== type),
                            }
                          : c,
                      ),
                    )
                  }
                />
                {eventNames[type]}
              </label>
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Удалить условие"
            onClick={() => onChange(conditions.filter((_, j) => j !== i))}
          >
            <X size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}

function SegmentForm({
  initial,
  tenants,
  onClose,
}: {
  initial: Segment | null;
  tenants: Tenant[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const tenantId = (code: string) =>
    tenants.find((t) => t.code === code)?.id ?? tenants[0]?.id ?? "";
  const [name, setName] = useState(initial?.name ?? ""),
    [days, setDays] = useState(initial?.definition.lookback_days ?? 90),
    [include, setInclude] = useState<Schema<"EventCondition">[]>(
      initial?.definition.include_all ?? [
        { tenant_id: tenantId("A"), event_types: ["interaction"] },
        { tenant_id: tenantId("B"), event_types: ["interaction"] },
      ],
    ),
    [exclude, setExclude] = useState<Schema<"EventCondition">[]>(
      initial?.definition.exclude_any ?? [
        { tenant_id: tenantId("C"), event_types: ["interaction"] },
      ],
    );
  const mutation = useMutation({
    mutationFn: () =>
      api(`/segments${initial ? `/${initial.id}` : ""}`, {
        method: initial ? "PUT" : "POST",
        body: JSON.stringify({
          name,
          definition: {
            lookback_days: days,
            include_all: include,
            exclude_any: exclude,
            require_verified_identity: true,
            require_complete_coverage: true,
          },
        }),
      }),
    onSuccess: () => {
      void client.invalidateQueries();
      onClose();
    },
  });
  return (
    <Dialog
      title={initial ? "Редактировать сегмент" : "Новый сегмент"}
      onClose={onClose}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Название сегмента
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            placeholder="Например: гости кинотеатра, ещё не знакомые с книжным"
          />
        </label>
        <label>
          Период истории, дней
          <input
            type="number"
            min="1"
            max="365"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            required
          />
        </label>
        <ConditionEditor
          title="Все эти события есть"
          conditions={include}
          tenants={tenants}
          onChange={setInclude}
        />
        <ConditionEditor
          title="Ни одного из этих событий нет"
          conditions={exclude}
          tenants={tenants}
          onChange={setExclude}
        />
        <Message>
          Учитываются профили с телефоном или email и полностью покрытый период
          истории. Состояние unknown не включается в аудиторию.
        </Message>
        <ErrorMessage error={mutation.error} />
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending}>Сохранить сегмент</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Segments() {
  const segments = useData<Schema<"SegmentPage">>(["segments"], "/segments"),
    tenants = useData<Schema<"TenantPage">>(["tenants"], "/tenants");
  const [selected, setSelected] = useState(""),
    [edit, setEdit] = useState<Segment | null | undefined>(),
    [offset, setOffset] = useState(0);
  const sid = selected || segments.data?.items[0]?.id,
    segment = segments.data?.items.find((s) => s.id === sid);
  const members = useData<Schema<"SegmentMemberPage">>(
    ["members", sid, offset],
    `/segments/${sid}/members?offset=${offset}`,
    !!sid,
  );
  const tenantName = (id: string) =>
    tenants.data?.items.find((t) => t.id === id)?.name ?? id;
  return (
    <>
      <Title
        title="Сегменты"
        text="Понятные условия. Проверяемая аудитория. Полная история."
        actions={
          <Button disabled={!tenants.data} onClick={() => setEdit(null)}>
            <Plus size={17} />
            Создать сегмент
          </Button>
        }
      />
      <ErrorMessage error={segments.error ?? members.error} />
      <div className="selection-layout">
        <aside className="selection-list">
          {segments.data?.items.map((s) => (
            <button
              key={s.id}
              className={`selection-card ${sid === s.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(s.id);
                setOffset(0);
              }}
            >
              <span className="selection-icon">
                <GitBranch size={20} />
              </span>
              <strong>{s.name}</strong>
              <small>
                {s.definition.lookback_days} дней ·{" "}
                {s.definition.include_all.length +
                  s.definition.exclude_any.length}{" "}
                условий
              </small>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </aside>
        <div>
          {segment ? (
            <>
              <Panel
                title={segment.name}
                subtitle={<>Срез: {when(members.data?.evaluation.as_of)} · КРСК <HelpTip term="Дата среза" /></>}
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEdit(segment)}
                  >
                    Редактировать
                  </Button>
                }
              >
                <div className="condition-summary">
                  {segment.definition.include_all.map((c, i) => (
                    <div key={`include-${i}`}>
                      <Badge tone="green">ЕСТЬ</Badge>
                      <span>{tenantName(c.tenant_id)}</span>
                      <small>
                        {c.event_types.map((t) => eventNames[t]).join(" / ")}
                      </small>
                    </div>
                  ))}
                  {segment.definition.exclude_any.map((c, i) => (
                    <div key={`exclude-${i}`}>
                      <Badge tone="blue">НЕТ ЗАПИСИ</Badge>
                      <span>{tenantName(c.tenant_id)}</span>
                      <small>
                        {c.event_types.map((t) => eventNames[t]).join(" / ")}
                      </small>
                    </div>
                  ))}
                </div>
                <div className="segment-counts">
                  {[
                    [
                      "В аудитории",
                      members.data?.evaluation.eligible_count,
                      "blue",
                    ],
                    [
                      "Не подходят",
                      members.data?.evaluation.ineligible_count,
                      "gray",
                    ],
                    [
                      "Недостаточно данных",
                      members.data?.evaluation.unknown_count,
                      "amber",
                    ],
                  ].map(([label, value, tone]) => (
                    <div key={String(label)}>
                      <span className={`dot dot-${tone}`} />
                      <strong>{value ?? "—"}</strong>
                      <small>{label}{label === "Недостаточно данных" && <HelpTip term="Недостаточно данных" />}</small>
                    </div>
                  ))}
                </div>
              </Panel>
              <Panel
                title="Клиенты сегмента"
                subtitle="Только подтверждённое соответствие всем условиям"
              >
                {members.isPending ? (
                  <Loading />
                ) : members.data?.items.length ? (
                  <>
                    <CustomerTable customers={members.data.items} />
                    <Pagination
                      offset={offset}
                      total={members.data.total}
                      onChange={setOffset}
                    />
                  </>
                ) : (
                  <Empty
                    title="Сейчас нет подходящих клиентов"
                    text="Загрузите события или проверьте условия и покрытие истории."
                  />
                )}
              </Panel>
              <Message>
                Unknown означает, что данных недостаточно. Такие профили не
                считаются уверенно подходящими для приглашения.
              </Message>
            </>
          ) : segments.isPending ? (
            <Loading />
          ) : (
            <Empty
              title="Создайте первый сегмент"
              text="Выберите сочетание арендаторов и событий, которое нужно найти."
            />
          )}
        </div>
      </div>
      {edit !== undefined && (
        <SegmentForm
          initial={edit}
          tenants={tenants.data?.items ?? []}
          onClose={() => setEdit(undefined)}
        />
      )}
    </>
  );
}

function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function RuleForm({
  initial,
  segments,
  tenants,
  onClose,
}: {
  initial: Rule | null;
  segments: Segment[];
  tenants: Tenant[];
  onClose: () => void;
}) {
  const client = useQueryClient(),
    [values, setValues] = useState({
      name: initial?.name ?? "",
      segment_id: initial?.segment_id ?? segments[0]?.id ?? "",
      destination_tenant_id: initial?.destination_tenant_id ?? "",
      priority: initial?.priority ?? 80,
      offer_title: initial?.offer_title ?? "",
      offer_description: initial?.offer_description ?? "",
      valid_from: localDateTime(
        initial?.valid_from ?? new Date().toISOString(),
      ),
      valid_until: localDateTime(
        initial?.valid_until ??
          new Date(Date.now() + 30 * 86400000).toISOString(),
      ),
      is_active: initial?.is_active ?? true,
    });
  const [offerReviewRequired, setOfferReviewRequired] = useState(false);
  const [offerReviewed, setOfferReviewed] = useState(false);
  const segment = segments.find(item => item.id === values.segment_id);
  const destinations = compatibleDestinations(segment?.definition, tenants);
  const destination = destinations.find(item => item.id === values.destination_tenant_id)
    ?? (destinations.length === 1 ? destinations[0] : undefined);
  const reviewRequired = offerReviewRequired || Boolean(initial && destination && destination.id !== initial.destination_tenant_id);

  function changeSelection(segmentId: string, destinationId: string) {
    if (destinationId !== (destination?.id ?? "")) {
      setOfferReviewRequired(Boolean(values.name.trim() || values.offer_title.trim() || values.offer_description.trim()));
      setOfferReviewed(false);
    }
    setValues({ ...values, segment_id: segmentId, destination_tenant_id: destinationId });
  }
  const mutation = useMutation({
    mutationFn: () =>
      api(`/recommendation-rules${initial ? `/${initial.id}` : ""}`, {
        method: initial ? "PUT" : "POST",
        body: JSON.stringify({
          ...values,
          destination_tenant_id: destination?.id,
          valid_from: new Date(values.valid_from).toISOString(),
          valid_until: new Date(values.valid_until).toISOString(),
        }),
      }),
    onSuccess: () => {
      void client.invalidateQueries();
      onClose();
    },
  });
  return (
    <Dialog
      title={
        initial ? "Редактировать рекомендацию" : "Новое правило рекомендации"
      }
      onClose={onClose}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (segment && destination && (!reviewRequired || offerReviewed)) mutation.mutate();
        }}
      >
        <label>
          Название правила
          <input
            value={values.name}
            onChange={(e) => setValues({ ...values, name: e.target.value })}
            required
            maxLength={120}
          />
        </label>
        <label>
          Кого приглашаем
          <select
            value={values.segment_id}
            onChange={(e) => {
              const next = segments.find(item => item.id === e.target.value);
              const available = compatibleDestinations(next?.definition, tenants);
              const nextDestination = available.find(item => item.id === destination?.id)
                ?? (available.length === 1 ? available[0] : undefined);
              changeSelection(e.target.value, nextDestination?.id ?? "");
            }}
            required
          >
            {segments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {segment && <AudienceSummary title="Условия выбранной аудитории" definition={segment.definition} tenants={tenants} />}
        {destinations.length === 1 ? (
          <div className="rule-destination" role="group" aria-label="Куда приглашаем">
            <span>Куда приглашаем</span>
            <strong>{destination?.name}</strong>
            <small>Назначение определено условиями выбранной аудитории.</small>
          </div>
        ) : destinations.length > 1 ? (
          <>
            <label>
              Куда приглашаем
              <select
                value={destination?.id ?? ""}
                onChange={event => changeSelection(values.segment_id, event.target.value)}
                aria-describedby="rule-destination-hint"
                required
              >
                <option value="">Выберите арендатора</option>
                {destinations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <div className="field-hint" id="rule-destination-hint">Аудитория подходит для нескольких арендаторов. Выберите, чьё предложение использовать.</div>
          </>
        ) : (
          <div className="field-hint" role="status" aria-label="Совместимость назначения">
            Нет совместимого назначения. Добавьте в разделе «Сегменты» исключение взаимодействия или покупки у арендатора, к которому хотите пригласить клиентов.
          </div>
        )}
        <div className="rule-offer-heading">
          <strong>{destination ? `Предложение арендатора: ${destination.name}` : "Предложение арендатора"}</strong>
          <span className="field-hint">Название правила служит для поиска в кабинете. Заголовок и описание относятся к предложению выбранного арендатора.</span>
        </div>
        <label>
          Заголовок предложения
          <input
            value={values.offer_title}
            onChange={(e) =>
              setValues({ ...values, offer_title: e.target.value })
            }
            required
            maxLength={160}
          />
        </label>
        <label>
          Описание
          <textarea
            value={values.offer_description}
            onChange={(e) =>
              setValues({ ...values, offer_description: e.target.value })
            }
            maxLength={1000}
            rows={3}
          />
        </label>
        {reviewRequired && destination && (
          <div className="rule-offer-review" role="group" aria-label="Проверка предложения" aria-live="polite">
            <strong>Назначение изменилось: {destination.name}</strong>
            <p>Название правила и текст предложения сохранены. Проверьте и при необходимости измените их для этого арендатора перед сохранением.</p>
            <label className="check-label">
              <input type="checkbox" checked={offerReviewed} onChange={event => setOfferReviewed(event.target.checked)} />
              Название и текст предложения проверены для {destination.name}
            </label>
          </div>
        )}
        <div className="form-grid">
          <label>
            Действует с
            <input
              type="datetime-local"
              value={values.valid_from}
              onChange={(e) =>
                setValues({ ...values, valid_from: e.target.value })
              }
              required
            />
          </label>
          <label>
            Действует до
            <input
              type="datetime-local"
              value={values.valid_until}
              onChange={(e) =>
                setValues({ ...values, valid_until: e.target.value })
              }
              required
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            <span>Бизнес-приоритет · 1–100 <HelpTip term="Приоритет" /></span>
            <input
              type="number"
              min="1"
              max="100"
              value={values.priority}
              onChange={(e) =>
                setValues({ ...values, priority: Number(e.target.value) })
              }
              required
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={values.is_active}
              onChange={(e) =>
                setValues({ ...values, is_active: e.target.checked })
              }
            />
            Правило активно
          </label>
        </div>
        <ErrorMessage error={mutation.error} />
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending || !segment || !destination || (reviewRequired && !offerReviewed)}>Сохранить правило</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Recommendations() {
  const rules = useData<Schema<"RecommendationRulePage">>(
      ["rules"],
      "/recommendation-rules",
    ),
    segments = useData<Schema<"SegmentPage">>(["segments"], "/segments"),
    tenants = useData<Schema<"TenantPage">>(["tenants"], "/tenants"),
    [edit, setEdit] = useState<Rule | null | undefined>();
  return (
    <>
      <Title
        title="Рекомендации"
        text="Объяснимые правила, которые находят подходящий следующий шаг."
        actions={
          <Button
            disabled={!segments.data?.total}
            onClick={() => setEdit(null)}
          >
            <Plus size={17} />
            Добавить правило
          </Button>
        }
      />
      <ErrorMessage error={rules.error} />
      <div className="rule-grid">
        {rules.data?.items.map((rule) => (
          <Panel key={rule.id} className="rule-card">
            <div className="source-card-top">
              <span className="source-icon crm_csv">
                <Sparkles size={24} />
              </span>
              <Badge
                tone={
                  rule.is_active && new Date(rule.valid_until) > new Date()
                    ? "green"
                    : "gray"
                }
              >
                {rule.is_active && new Date(rule.valid_until) > new Date()
                  ? "Активно"
                  : "Неактивно"}
              </Badge>
            </div>
            <h2>{rule.name}</h2>
            <div className="rule-destination">
              {
                tenants.data?.items.find(
                  (t) => t.id === rule.destination_tenant_id,
                )?.name
              }
              <ArrowUpRight size={18} />
            </div>
            <p>{rule.offer_title}</p>
            <p className="muted">{rule.offer_description}</p>
            <div className="rule-meta">
              <span>
                Аудитория
                <strong>
                  {
                    segments.data?.items.find((s) => s.id === rule.segment_id)
                      ?.name
                  }
                </strong>
              </span>
              <span>
                Приоритет<strong>{rule.priority} / 100</strong>
              </span>
              <span>
                Действует до<strong>{when(rule.valid_until)}</strong>
              </span>
            </div>
            <Button
              variant="outline"
              className="full"
              onClick={() => setEdit(rule)}
            >
              Редактировать правило
            </Button>
          </Panel>
        ))}
      </div>
      {rules.data && !rules.data.total && (
        <Empty
          title="Пока нет правил"
          text="Создайте сегмент и добавьте предложение подходящего арендатора."
        />
      )}
      <Message>
        Каждая рекомендация в профиле содержит реальные события и период, за
        который нет зарегистрированного взаимодействия. Пустой результат тоже
        объясняется.
      </Message>
      {edit !== undefined && (
        <RuleForm
          initial={edit}
          segments={segments.data?.items ?? []}
          tenants={tenants.data?.items ?? []}
          onClose={() => setEdit(undefined)}
        />
      )}
    </>
  );
}

function CampaignForm({
  segments,
  rules,
  onClose,
  onCreated,
}: {
  segments: Segment[];
  rules: Rule[];
  onClose: () => void;
  onCreated: (campaign: Campaign) => void;
}) {
  const [name, setName] = useState(""),
    [ruleId, setRuleId] = useState(rules[0]?.id ?? ""),
    [channel, setChannel] = useState("email");
  const chosen = rules.find((r) => r.id === ruleId);
  const mutation = useMutation({
    mutationFn: () =>
      api<Campaign>("/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name,
          recommendation_rule_id: ruleId,
          segment_id: chosen?.segment_id,
          channel,
        }),
      }),
    onSuccess: onCreated,
  });
  return (
    <Dialog title="Новая кампания" onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Название
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            placeholder="Например: знакомство с книжным"
          />
        </label>
        <label>
          Правило рекомендации
          <select
            value={ruleId}
            onChange={(e) => setRuleId(e.target.value)}
            required
          >
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field-hint">
          Сегмент:{" "}
          {segments.find((s) => s.id === chosen?.segment_id)?.name ??
            "Выберите правило"}
        </div>
        <label>
          Канал выгрузки
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="email">Email</option>
            <option value="sms">SMS</option>

          </select>
        </label>
        <Message>
          Будет создан CSV для внешней системы. Платформа не отправляет
          сообщения.
        </Message>
        <ErrorMessage error={mutation.error} />
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending}>Создать кампанию</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Campaigns() {
  const [searchParams] = useSearchParams();
  const client = useQueryClient(),
    campaigns = useData<Schema<"CampaignPage">>(["campaigns"], "/campaigns"),
    segments = useData<Schema<"SegmentPage">>(["segments"], "/segments"),
    rules = useData<Schema<"RecommendationRulePage">>(
      ["rules"],
      "/recommendation-rules",
    );
  const [selected, setSelected] = useState(searchParams.get("campaign") ?? ""),
    [create, setCreate] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  const cid = selected || campaigns.data?.items[0]?.id,
    campaign = campaigns.data?.items.find((c) => c.id === cid);
  const preview = useData<Schema<"ExportPreview">>(
      ["preview", cid],
      `/campaigns/${cid}/preview`,
      !!cid,
    ),
    exports = useData<Schema<"ExportPage">>(
      ["exports", cid],
      `/campaigns/${cid}/exports`,
      !!cid,
    );
  const mutation = useMutation({
    mutationFn: () =>
      api<Schema<"Export">>(`/campaigns/${cid}/exports`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
      }),
    onSuccess: () => {
      setKey(crypto.randomUUID());
      void client.invalidateQueries();
    },
  });
  return (
    <>
      <Title
        title="Кампании"
        text="Подготовьте релевантную аудиторию и передайте её в маркетинг."
        actions={
          <Button disabled={!rules.data?.total} onClick={() => setCreate(true)}>
            <Plus size={17} />
            Создать кампанию
          </Button>
        }
      />
      <ErrorMessage
        error={campaigns.error ?? preview.error ?? mutation.error}
      />
      <div className="selection-layout">
        <aside className="selection-list">
          {campaigns.data?.items.map((c) => (
            <button
              key={c.id}
              className={`selection-card ${cid === c.id ? "selected" : ""}`}
              onClick={() => {
                setSelected(c.id);
                setKey(crypto.randomUUID());
                mutation.reset();
              }}
            >
              <span className="selection-icon">
                <Send size={20} />
              </span>
              <strong>{c.name}</strong>
              <small>
                {c.channel.toUpperCase()} · {when(c.created_at)}
              </small>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </aside>
        <div>
          {campaign ? (
            <>
              <Panel
                title={campaign.name}
                subtitle={<>Канал: {campaign.channel.toUpperCase()} · Срез: {when(preview.data?.as_of)} · КРСК <HelpTip term="Дата среза" /></>}
              >
                <div className="campaign-stats">
                  <div>
                    <span>В сегменте <HelpTip term="Сегмент" /></span>
                    <strong>{preview.data?.base_count ?? "—"}</strong>
                  </div>
                  <ArrowRight className="muted" size={23} />
                  <div>
                    <span>Готовы к выгрузке <HelpTip term="Выгрузка" /></span>
                    <strong className="blue-text">
                      {preview.data?.eligible_count ?? "—"}
                    </strong>
                  </div>
                  <div className="campaign-cta">
                    <Button
                      disabled={
                        mutation.isPending || !preview.data?.eligible_count
                      }
                      onClick={() => mutation.mutate()}
                    >
                      {mutation.isPending ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <ArrowDownToLine size={17} />
                      )}
                      Сформировать CSV
                    </Button>
                  </div>
                </div>
                <div className="exclusions">
                  {preview.data &&
                    Object.entries(preview.data.excluded_counts).map(
                      ([reason, count]) => (
                        <div key={reason}>
                          <span
                            className={count ? "dot dot-amber" : "dot dot-gray"}
                          />
                          <span>{reasonNames[reason]} <HelpTip term={reasonNames[reason]} /></span>
                          <strong>{count}</strong>
                        </div>
                      ),
                    )}
                </div>
              </Panel>
              {mutation.isSuccess && (
                <Message>
                  Выгрузка сформирована. Скачайте её в истории ниже. Повторное
                  скачивание не меняет аудиторию.
                </Message>
              )}
              <Panel
                title="Предпросмотр получателей"
                subtitle="Предварительный расчёт не резервирует контакты"
              >
                {preview.isPending ? (
                  <Loading />
                ) : preview.data?.sample.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Клиент</th>
                          <th>Контакт</th>
                          <th>Предложение</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.data.sample.map((p) => (
                          <tr key={p.customer_id}>
                            <td>
                              <Link to={`/customers/${p.customer_id}`}>
                                <strong>{p.display_name}</strong>
                                <small>{p.global_customer_key}</small>
                              </Link>
                            </td>
                            <td>{p.contact}</td>
                            <td>{p.offer_title}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="inline-empty">
                    Подходящих контактов сейчас нет. Проверьте причины
                    исключения выше.
                  </div>
                )}
              </Panel>
              <Panel
                title="История выгрузок"
                subtitle="Сохраняем готовый файл и факт выгрузки"
              >
                {exports.data?.items.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Создана</th>
                          <th>Получателей</th>
                          <th>Файл</th>
                        </tr>
                      </thead>
                      <tbody>
                        {exports.data.items.map((item) => (
                          <tr key={item.id}>
                            <td>{when(item.created_at)}</td>
                            <td>{item.recipient_count}</td>
                            <td>
                              <ExportDownload id={item.id} url={item.download_url} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="inline-empty">
                    Готовые выгрузки появятся здесь.
                  </div>
                )}
              </Panel>
              <Message>
                Ограничение частоты — 7 дней по фактам выгрузки. Справочник
                отписок не подключён. Реальная отправка сообщений выполняется
                внешней системой.
              </Message>
            </>
          ) : campaigns.isPending ? (
            <Loading />
          ) : (
            <Empty
              title="Создайте первую кампанию"
              text="Выберите правило рекомендации и канал, для которого нужна аудитория."
            />
          )}
        </div>
      </div>
      {create && (
        <CampaignForm
          segments={segments.data?.items ?? []}
          rules={rules.data?.items ?? []}
          onClose={() => setCreate(false)}
          onCreated={(c) => {
            setSelected(c.id);
            setCreate(false);
            void client.invalidateQueries();
          }}
        />
      )}
    </>
  );
}
