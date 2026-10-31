import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";

const explanations: Record<string, string> = {
  "Профиль": "Записи одного клиента от разных арендаторов, объединённые по телефону или email внутри вашего ТЦ.",
  "Источник": "Подключение арендатора, из которого платформа получает телефон, email и время взаимодействия.",
  "Полнота истории": "Период, за который арендатор гарантирует передачу всех взаимодействий. Успешная загрузка файла сама по себе не подтверждает полноту.",
  "Дата среза": "До какого момента проверены данные участвующих арендаторов. Более новые записи видны в профиле, но могут ещё не участвовать в расчёте.",
  "Сегмент": "Группа клиентов, соответствующих сохранённым условиям. Состав меняется при новых взаимодействиях и пересчёте.",
  "Недостаточно данных": "Нельзя уверенно проверить условия: не хватает контактов или полной истории. Эти клиенты не включаются в аудиторию.",
  "Приоритет": "Порядок показа предложений от 1 до 100. Задаётся маркетологом и не означает вероятность покупки.",
  "Отношение частот": "Во сколько раз взаимодействие с арендатором чаще встречается в выбранной группе, чем во всей активной базе. Это наблюдение, а не прогноз результата кампании.",
  "Общие клиенты": "Уникальные клиенты, у которых зарегистрированы взаимодействия и в исходных местах, и у арендатора назначения.",
  "Новая аудитория": "Клиенты с взаимодействиями в исходных местах, у которых за выбранный полный период нет взаимодействия с арендатором назначения.",
  "Выгрузка": "CSV с подходящими контактами для внешней системы рассылки. Создание файла не отправляет сообщения.",
  "Ограничение частоты": "Один контакт нельзя повторно выгружать в том же канале в течение 7 дней. Считается по созданным файлам, а не по отправленным сообщениям.",
  "Конфликт контактов": "Для одного клиента получено несколько разных значений выбранного канала. Платформа не выбирает одно наугад и исключает такой контакт из выгрузки.",
  "Повтор контакта": "Один и тот же адрес или телефон встретился у нескольких кандидатов. В файл он попадёт только один раз.",
  "Уже выгружен": "Контакт уже включался в файл этой кампании. Существующий файл можно скачать повторно в истории.",
  "Есть контакты": "Есть корректный телефон или email для сопоставления записей. Это не проверка личности клиента.",
};

export function HelpTip({ term, text }: { term: string; text?: string }) {
  const id = useId();
  const [position, setPosition] = useState<{ x: number; y: number; below: boolean } | null>(null);
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", key);
    };
  }, [position]);
  function show(element: HTMLButtonElement) {
    const box = element.getBoundingClientRect();
    const below = box.top < 150;
    setPosition({ x: Math.max(154, Math.min(innerWidth - 154, box.x + box.width / 2)), y: below ? box.bottom + 9 : box.top - 9, below });
  }
  return <>
    <button type="button" className="help-tip" aria-label={`Что значит «${term}»`} aria-describedby={position ? id : undefined}
      onMouseEnter={event => show(event.currentTarget)} onMouseLeave={() => setPosition(null)}
      onFocus={event => show(event.currentTarget)} onBlur={() => setPosition(null)}
      onClick={event => show(event.currentTarget)}><CircleHelp size={13} /></button>
    {position && createPortal(<div id={id} role="tooltip" className="help-tooltip" style={{ left: position.x, top: position.y, transform: `translate(-50%, ${position.below ? "0" : "-100%"})` }}><strong>{term}</strong><span>{text ?? explanations[term] ?? term}</span></div>, document.body)}
  </>;
}
