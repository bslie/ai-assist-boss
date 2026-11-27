export const metadata = { title: "Политика конфиденциальности · ИИ-помощник руководителя" };

const UPDATED = "27 ноября 2026";

/**
 * Публичная страница для регистрации приложения в Google Cloud и других сервисах. Входа не требует
 * и в меню не показывается: на неё дают только ссылку. Текст описывает то, что приложение делает на самом деле.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-6 px-5 py-12 text-[15px] leading-relaxed text-soft">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl font-normal text-foreground">Политика конфиденциальности</h1>
        <p className="text-dim">ИИ-помощник руководителя · обновлено {UPDATED}</p>
      </header>

      <p>
        «ИИ-помощник руководителя» разбирает почту и календарь руководителя, готовит протоколы встреч и поручения. Здесь описано, какие данные мы получаем, зачем
        они нужны и как их удалить.
      </p>

      <Section title="Какие данные мы получаем">
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>
            <b className="text-foreground">Почта (Gmail, Яндекс, Microsoft 365).</b> Входящие письма: отправитель, тема, текст, получатели. Только после того, как вы сами
            подключили ящик.
          </li>
          <li>
            <b className="text-foreground">Календарь.</b> Название, время, участники и ссылки встреч.
          </li>
          <li>
            <b className="text-foreground">Расшифровки встреч.</b> Текст встреч, на которые вы отправили помощника.
          </li>
          <li>
            <b className="text-foreground">Данные аккаунта.</b> Адрес электронной почты аккаунта, чтобы показать, какой ящик подключён, и не разбирать собственные письма.
          </li>
        </ul>
      </Section>

      <Section title="Зачем они нужны">
        <p>
          Только чтобы работать для вас: сортировать письма, готовить черновики ответов и карточки решений, напоминать о встречах и собирать протоколы. Мы не продаём данные,
          не показываем рекламу и не используем письма, календарь и расшифровки для обучения общих моделей.
        </p>
      </Section>

      <Section title="Что помощник делает от вашего имени">
        <p>
          Письма и приглашения уходят только после вашего подтверждения или по правилам, которые вы сами включили. Кадровые вопросы, вопросы руководства, обещания клиентам и
          крупные суммы всегда остаются за вами. Права на каждое действие можно изменить или запретить в разделе «Подключения».
        </p>
      </Section>

      <Section title="Обработка языковой моделью">
        <p>
          Чтобы понять смысл письма или встречи, нужный фрагмент текста передаётся поставщику языковой модели, который настроен в сервисе. Передаётся только то, что нужно для
          конкретной задачи.
        </p>
      </Section>

      <Section title="Использование данных Google">
        <p>
          Использование и передача информации, полученной из API Google, соответствует{" "}
          <a className="text-amber underline underline-offset-4" href="https://developers.google.com/terms/api-services-user-data-policy" rel="noreferrer">
            Политике в отношении пользовательских данных в API-сервисах Google
          </a>
          , включая требования ограниченного использования (Limited Use).
        </p>
        <p className="text-dim">
          The use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use
          requirements.
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>Данные Gmail и Google Календаря используются только для функций, которые вы видите в приложении.</li>
          <li>Мы не передаём их третьим лицам, кроме поставщиков, без которых функция не работает (хранение, языковая модель), и случаев, когда это требует закон.</li>
          <li>Люди не читают ваши письма, кроме случаев, когда вы сами об этом попросили или это нужно для расследования сбоя и безопасности.</li>
        </ul>
      </Section>

      <Section title="Где и как хранятся данные">
        <p>
          Токены доступа и пароли хранятся в базе в зашифрованном виде и не показываются в интерфейсе. Все запросы к данным ограничены вашим аккаунтом. Передача данных
          идёт по защищённому соединению.
        </p>
      </Section>

      <Section title="Как отозвать доступ и удалить данные">
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>В разделе «Подключения» нажмите «Отключить и стереть доступы»: сохранённые токены удаляются сразу.</li>
          <li>
            Доступ Google можно отозвать и на странице{" "}
            <a className="text-amber underline underline-offset-4" href="https://myaccount.google.com/permissions" rel="noreferrer">
              myaccount.google.com/permissions
            </a>
            .
          </li>
          <li>Чтобы удалить уже сохранённые письма, карточки и протоколы, обратитесь к администратору сервиса: данные руководителя удаляются целиком.</li>
        </ul>
      </Section>

      <Section title="Изменения политики">
        <p>Если мы изменим, какие данные собираем или как их используем, мы обновим эту страницу и дату вверху.</p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-serif text-2xl font-normal text-foreground">{title}</h2>
      {children}
    </section>
  );
}
