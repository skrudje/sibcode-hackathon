import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight, Database, GitBranch, HelpCircle, LayoutDashboard, Link2,
  LoaderCircle, LogOut, PanelLeft, Radar, RefreshCw, Search, Send, Sparkles, Users,
} from "lucide-react";
import { api } from "../api";
import { desktop } from "../transport";
import { DesktopConnection } from "./desktop";
import { Dialog } from "./ui/dialog";

export const workspaceLinks = [
  { to: "/", label: "Обзор", description: "Профили, события и последние загрузки", icon: LayoutDashboard },
  { to: "/sources", label: "Источники данных", description: "Загрузка файлов и журнал импорта", icon: Database },
  { to: "/customers", label: "Клиенты", description: "Поиск профиля и история событий", icon: Users },
  { to: "/segments", label: "Сегменты", description: "Условия отбора и участники", icon: GitBranch },
  { to: "/recommendations", label: "Рекомендации", description: "Правила и предложения арендаторов", icon: Sparkles },
  { to: "/campaigns", label: "Кампании", description: "Подготовка аудитории и выгрузка CSV", icon: Send },
  { to: "/radar", label: "Радар новых визитов", description: "Связи арендаторов и новые аудитории", icon: Radar },
];

const sidebarKey = "hryukers.sidebar-collapsed";
function savedSidebar() {
  try { return localStorage.getItem(sidebarKey) === "true"; }
  catch { return false; }
}

export function Workspace({ email, onHelp, onLogout, loggingOut, children }: {
  email: string;
  onHelp: () => void;
  onLogout: () => void;
  loggingOut: boolean;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const content = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(savedSidebar);
  const [commands, setCommands] = useState(false);
  const fetching = useIsFetching({ predicate: (q) => q.queryKey[0] !== "connection-health" });
  const health = useQuery({
    queryKey: ["connection-health"],
    queryFn: ({ signal }) => api<{ status: string }>("/health/ready", { signal }),
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: false,
  });
  const active = workspaceLinks.find((link) => link.to === "/"
    ? location.pathname === "/" : location.pathname.startsWith(link.to));
  const Icon = active?.icon ?? Users;

  useEffect(() => {
    try { localStorage.setItem(sidebarKey, String(collapsed)); } catch { /* Optional preference. */ }
  }, [collapsed]);
  useEffect(() => { content.current?.scrollTo({ top: 0 }); }, [location.pathname]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"]') && !commands) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === "k" || event.code === "KeyK")) {
        event.preventDefault();
        setCommands((value) => !value);
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && (key === "b" || event.code === "KeyB")) {
        event.preventDefault();
        setCollapsed((value) => !value);
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(key) && workspaceLinks[Number(key) - 1]) {
        event.preventDefault();
        navigate(workspaceLinks[Number(key) - 1].to);
        setCommands(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [commands, navigate]);

  return (
    <div className={`app-shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="Разделы платформы">
        <Link to="/" className="brand" title="Хрюкерсы CDP — обзор">
          <span className="brand-icon"><Link2 size={20} /></span>
          <span className="brand-name">Хрюкерсы <small>CDP</small></span>
        </Link>
        <div className="mall-context" title="ТЦ «Орбита» · Управляющая компания">
          <span className="mall-icon">О</span>
          <div><strong>ТЦ «Орбита»</strong><small>Управляющая компания</small></div>
        </div>
        <div className="nav-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav aria-label="Основная навигация">
          {workspaceLinks.map(({ to, label, icon: NavIcon }, index) => (
            <NavLink key={to} to={to} end={to === "/"} title={`${label} · Alt+${index + 1}`}
              aria-label={label} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
              <NavIcon size={17} /><span>{label}</span><kbd>{index + 1}</kbd>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <DesktopConnection className="nav-link" />
          <button className="nav-link" aria-label="Как работает платформа" onClick={onHelp} title="Как работает платформа">
            <HelpCircle size={17} /><span>Справка</span>
          </button>
          <div className="account">
            <span className="avatar avatar-user" aria-hidden>МК</span>
            <div><strong>Маркетолог УК</strong><span title={email}>{email}</span></div>
            <button className="icon-button" aria-label="Выйти" title="Выйти" disabled={loggingOut} onClick={onLogout}>
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="toolbar-section">
            <button className="icon-button sidebar-toggle" onClick={() => setCollapsed((value) => !value)}
              aria-expanded={!collapsed} aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"} title="Меню · Ctrl+B">
              <PanelLeft size={17} />
            </button>
            <span className="toolbar-divider" />
            <span className="section-title"><Icon size={16} />{active?.label ?? "Профиль клиента"}</span>
          </div>
          <div className="toolbar-section">
            <button className="command-trigger" onClick={() => setCommands(true)} aria-label="Быстрый переход" aria-keyshortcuts="Control+k Meta+k">
              <Search size={14} /><span>Перейти в раздел…</span><kbd>Ctrl K</kbd>
            </button>
            <button className="toolbar-refresh" disabled={fetching > 0} onClick={() => void client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" })}
              aria-label="Обновить данные" title="Обновить данные текущего раздела">
              <RefreshCw size={15} className={fetching ? "spin" : ""} /><span>Обновить</span>
            </button>
          </div>
        </header>
        <main className={`main${location.pathname === "/customers" ? " main-records" : ""}`} ref={content} id="workspace-content" tabIndex={-1}>{children}</main>
      </div>
      <footer className="statusbar" aria-label="Состояние платформы">
        <div className="statusbar-group">
          <span className={`connection-state ${health.isError ? "connection-error" : health.isPending ? "connection-pending" : "connection-ok"}`} role="status">
            <i className="status-dot" />{health.isError ? "Нет связи с сервером" : health.isPending ? "Проверка подключения…" : "Сервер доступен"}
          </span>
        </div>
        <div className="statusbar-group statusbar-meta">
          {fetching > 0 && <span className="fetch-status"><LoaderCircle size={12} className="spin" /> Обновление…</span>}
          <span>Демоданные</span><span>КРСК · UTC+7</span><span>{desktop ? "Desktop" : "Browser"} · 0.1.0</span>
        </div>
      </footer>
      {commands && <QuickSwitch onClose={() => setCommands(false)} />}
    </div>
  );
}

function QuickSwitch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(0);
  const id = useId();
  const matches = workspaceLinks.filter((link) => `${link.label} ${link.description}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru").trim()));
  function choose(to: string) { onClose(); navigate(to); }
  useEffect(() => { document.getElementById(`${id}-${selected}`)?.scrollIntoView({ block: "nearest" }); }, [id, selected]);
  return (
    <Dialog title="Быстрый переход" onClose={onClose}>
      <div className="quick-switch">
        <label className="command-input"><Search size={18} />
          <input autoFocus role="combobox" aria-label="Найти раздел" aria-autocomplete="list" aria-expanded
            aria-controls={id} aria-activedescendant={matches.length ? `${id}-${selected}` : undefined}
            placeholder="Название раздела или задачи" value={search}
            onChange={(event) => { setSearch(event.target.value); setSelected(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (matches.length) setSelected((value) => (value + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              }
              if (event.key === "Enter" && matches[selected]) { event.preventDefault(); choose(matches[selected].to); }
            }} />
        </label>
        <div id={id} role="listbox" aria-label="Разделы" className="command-results">
          {matches.map(({ to, label, description, icon: Icon }, index) => (
            <button key={to} id={`${id}-${index}`} role="option" aria-selected={index === selected} tabIndex={-1}
              onMouseEnter={() => setSelected(index)} onClick={() => choose(to)}>
              <Icon size={18} /><span><strong>{label}</strong><small>{description}</small></span><ArrowRight size={15} />
            </button>
          ))}
        </div>
        {!matches.length && <p className="command-empty">Раздел не найден. Попробуйте «клиенты» или «загрузка».</p>}
        <div className="command-hints"><span><kbd>↑</kbd><kbd>↓</kbd> выбор</span><span><kbd>Enter</kbd> открыть</span><span><kbd>Esc</kbd> закрыть</span></div>
      </div>
    </Dialog>
  );
}
