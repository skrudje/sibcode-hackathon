import { test, expect } from '@playwright/test'

 test('администратор добавляет арендатора, загружает единый файл и открывает профиль', async ({ page }) => {
  const tenant = `Студия «Керамика» ${Date.now()}`
  const phone = `+7913${String(Date.now()).slice(-7)}`
  const email = `ceramics-${Date.now()}@example.invalid`
  const customerName = `Клиент ${phone.slice(-4)}`
  await page.goto('/')
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com')
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.ADMIN_PASSWORD || 'HryukersAdmin2026!')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await page.getByRole('link', { name: 'Интеграции', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить арендатора', exact: true }).click()
  await page.getByLabel('Название', { exact: true }).fill(tenant)
  await page.getByLabel('Категория', { exact: true }).fill('Творчество')
  await page.getByRole('dialog').getByRole('button', { name: 'Добавить арендатора', exact: true }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByRole('table')).toContainText(tenant)
  await page.getByRole('button', { name: `Настроить ${tenant}`, exact: true }).click()
  await expect(page.getByLabel('Адрес API')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('phone, email, time')
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await page.screenshot({ path: '../../.data/qa/integrations.png' })
  await page.getByRole('link', { name: 'Источники данных', exact: true }).click()
  await page.getByLabel('Арендатор для загрузки', { exact: true }).selectOption({ label: tenant })
  let uploads = 0
  page.on('request', request => { if (request.method() === 'POST' && /\/sources\/[^/]+\/imports$/.test(request.url())) uploads++ })
  const dropFile = async (name: string, content: string, type: string) => {
    const transfer = await page.evaluateHandle(({ name, content, type }) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([content], name, { type }))
      return transfer
    }, { name, content, type })
    await page.locator('.upload-dropzone').dispatchEvent('drop', { dataTransfer: transfer })
    await transfer.dispose()
  }
  await dropFile('contacts.zip', 'unsupported', 'application/zip')
  await expect(page.getByRole('alert')).toContainText('Выберите CSV или Excel')
  expect(uploads).toBe(0)
  const timestamp = new Date(Date.now()-3600_000).toISOString()
  const csv = `phone,email,time\n${phone},${email},${timestamp}\n`
  await dropFile('contacts.csv', csv, 'text/csv')
  await expect(page.getByText('Файл обработан.', { exact: false })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('alert')).not.toBeVisible()
  expect(uploads).toBe(1)
  await page.getByRole('link', { name: 'Клиенты', exact: true }).click()
  await page.getByRole('textbox', { name: 'Поиск клиентов' }).fill(email)
  await page.getByRole('link', { name: `Открыть ${customerName}`, exact: true }).click()
  await expect(page.getByRole('heading', { name: customerName, exact: true })).toBeVisible()
  await expect(page.getByText('Взаимодействие', { exact: true })).toBeVisible()
  await expect(page.locator('body')).not.toContainText(/демо/i)
  await page.screenshot({ path: '../../.data/qa/profile.png' })
})

test('формы правил и мобильная вёрстка', async ({ page }) => {
  const suffix = Date.now()
  const segmentName = `Тестовый сегмент ${suffix}`
  const ruleName = `Тестовое правило ${suffix}`
  const campaignName = `Тестовая SMS-кампания ${suffix}`
  await page.goto('/')
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_PASSWORD || 'HryukersDemo2026!')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await page.getByRole('link', { name: 'Сегменты', exact: true }).click()
  await page.getByRole('button', { name: 'Создать сегмент' }).click()
  await page.getByLabel('Название сегмента').fill(segmentName)
  await page.getByRole('button', { name: 'Сохранить сегмент' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.getByRole('link', { name: 'Рекомендации', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить правило' }).click()
  await page.getByLabel('Название правила').fill(ruleName)
  await page.getByRole('combobox', { name: 'Кого приглашаем', exact: true }).selectOption({ label: segmentName })
  await page.getByLabel('Заголовок предложения').fill('Новое предложение')
  const offerReview = page.getByRole('group', { name: 'Проверка предложения' }).getByRole('checkbox')
  if (await offerReview.isVisible()) await offerReview.check()
  await page.getByRole('button', { name: 'Сохранить правило' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByRole('heading', { name: ruleName, exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Кампании', exact: true }).click()
  await page.getByRole('button', { name: 'Создать кампанию' }).click()
  await page.getByRole('combobox', { name: 'Кого приглашаем', exact: true }).selectOption({ label: segmentName })
  await page.getByRole('button', { name: 'Далее: предложение', exact: true }).click()
  await page.getByRole('combobox', { name: 'Предложение арендатора', exact: true }).selectOption({ label: 'Новое предложение' })
  await page.getByRole('button', { name: 'Далее: проверка', exact: true }).click()
  await page.getByLabel('Название кампании', { exact: true }).fill(campaignName)
  await page.getByRole('radio', { name: /SMS/ }).check()
  await expect(page.getByRole('button', { name: 'Создать кампанию', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Создать кампанию', exact: true }).click()
  await expect(page.getByRole('heading', { name: campaignName })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('link', { name: 'Обзор', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await page.screenshot({ path: '../../.data/qa/mobile.png', fullPage: true })
})
