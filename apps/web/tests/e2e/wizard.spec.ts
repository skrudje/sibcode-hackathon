import { test, expect, type Page } from '@playwright/test'

test.setTimeout(240_000)

async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_PASSWORD || 'HryukersDemo2026!')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()
  await expect.poll(async () => {
    const jobs = (await (await page.request.get('/api/v1/imports?limit=100')).json()).items
    return jobs.length > 0 && jobs.every((job: { status: string }) => !['queued', 'running'].includes(job.status))
  }, { timeout: 180_000 }).toBeTruthy()
}

async function counts(page: Page) {
  return Promise.all(['/segments', '/recommendation-rules', '/campaigns'].map(async path => (await (await page.request.get(`/api/v1${path}`)).json()).total))
}

test('мастер: свои условия, новое предложение, предпросмотр без сохранения и возврат между шагами', async ({ page }) => {
  await login(page)
  const before = await counts(page)
  await page.getByRole('link', { name: 'Кампании', exact: true }).click()
  await page.getByRole('button', { name: 'Создать кампанию', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Создать кампанию', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Новые условия', exact: true }).click()
  await page.getByLabel('Название аудитории').fill('Мастер · после кино и кафе')
  await page.screenshot({ path: '../../.data/qa/wizard-audience.png', fullPage: true })
  await page.getByRole('button', { name: 'Далее: предложение', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'С каким предложением?' })).toBeVisible()
  await page.getByRole('button', { name: 'Новое предложение', exact: true }).click()
  await page.getByLabel('Заголовок предложения', { exact: true }).fill('Книги для нового знакомства')
  await page.getByLabel('Описание предложения', { exact: true }).fill('Подборка книг для новых гостей книжного.')
  await page.screenshot({ path: '../../.data/qa/wizard-offer.png', fullPage: true })
  await page.getByRole('button', { name: 'Далее: проверка', exact: true }).click()
  await page.getByLabel('Название кампании', { exact: true }).fill('Мастер · книжный')
  await page.getByRole('radio', { name: /SMS/ }).check()
  const create = page.getByRole('button', { name: 'Создать кампанию', exact: true })
  await expect(create).toBeEnabled()
  await expect(page.getByLabel('Результат проверки контактов')).toContainText('Доступны для SMS')
  expect(await counts(page)).toEqual(before)
  await page.getByRole('button', { name: 'Назад', exact: true }).click()
  await expect(page.getByLabel('Заголовок предложения', { exact: true })).toHaveValue('Книги для нового знакомства')
  await page.getByRole('button', { name: 'Назад', exact: true }).click()
  await expect(page.getByLabel('Название аудитории')).toHaveValue('Мастер · после кино и кафе')
  await page.getByRole('button', { name: 'Далее: предложение', exact: true }).click()
  await page.getByRole('button', { name: 'Далее: проверка', exact: true }).click()
  await expect(page.getByLabel('Название кампании', { exact: true })).toHaveValue('Мастер · книжный')
  await expect(page.getByRole('radio', { name: /SMS/ })).toBeChecked()
  await expect(create).toBeEnabled()
  await page.screenshot({ path: '../../.data/qa/wizard-review.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await page.screenshot({ path: '../../.data/qa/wizard-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await create.click()
  await expect(page.getByRole('heading', { name: 'Мастер · книжный', exact: true })).toBeVisible()
  expect(await counts(page)).toEqual(before.map(value => value + 1))
  await expect(page.getByRole('button', { name: 'Сформировать CSV', exact: true })).toBeEnabled()
})

test('мастер из рекомендации использует готовые записи, отмена не оставляет черновиков', async ({ page }) => {
  await login(page)
  const rules = (await (await page.request.get('/api/v1/recommendation-rules?limit=100')).json()).items
  const rule = rules.find((item: { name: string }) => item.name === 'Приглашение: Детский центр «Точка игры»')
  expect(rule).toBeTruthy()
  // Equivalent offers from another segment must not hide the linked rule or cause another copy.
  const origin = new URL(page.url()).origin
  const source = await (await page.request.get(`/api/v1/segments/${rule.segment_id}`)).json()
  const duplicateSegmentResponse = await page.request.post('/api/v1/segments', { headers: { Origin: origin }, data: { name: 'Другая аудитория того же предложения', definition: source.definition } })
  expect(duplicateSegmentResponse.ok()).toBeTruthy()
  const duplicateSegment = await duplicateSegmentResponse.json()
  const duplicateRuleResponse = await page.request.post('/api/v1/recommendation-rules', { headers: { Origin: origin }, data: {
    name: 'Копия предложения для другого сегмента', segment_id: duplicateSegment.id, destination_tenant_id: rule.destination_tenant_id,
    priority: Math.min(100, rule.priority + 1), offer_title: rule.offer_title, offer_description: rule.offer_description,
    valid_from: rule.valid_from, valid_until: rule.valid_until, is_active: true,
  } })
  expect(duplicateRuleResponse.ok()).toBeTruthy()
  const before = await counts(page)
  await page.getByRole('link', { name: 'Рекомендации', exact: true }).click()
  const card = page.locator('.rule-card').filter({ has: page.getByRole('heading', { name: rule.name, exact: true }) })
  await card.getByRole('button', { name: 'Создать кампанию', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Кого приглашаем', exact: true })).toHaveValue(rule.segment_id)
  await page.getByRole('button', { name: 'Далее: предложение', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Предложение арендатора', exact: true })).toHaveValue(rule.id)
  await page.getByRole('button', { name: 'Далее: проверка', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Создать кампанию', exact: true })).toBeEnabled()
  expect(await counts(page)).toEqual(before)
  await page.getByRole('link', { name: 'Назад к рекомендациям', exact: true }).click()
  expect(await counts(page)).toEqual(before)
  await card.getByRole('button', { name: 'Создать кампанию', exact: true }).click()
  await page.getByRole('button', { name: 'Далее: предложение', exact: true }).click()
  await page.getByRole('button', { name: 'Далее: проверка', exact: true }).click()
  await page.getByLabel('Название кампании', { exact: true }).fill('Мастер · готовое правило')
  await expect(page.getByRole('button', { name: 'Создать кампанию', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Создать кампанию', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Мастер · готовое правило', exact: true })).toBeVisible()
  const after = await counts(page)
  expect(after).toEqual([before[0], before[1], before[2] + 1])
})
