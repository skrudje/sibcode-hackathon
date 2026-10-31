import { test, expect } from '@playwright/test'

test('правило объясняет аудиторию и меняет доступные назначения вместе с сегментом', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Пароль', { exact: true }).fill(process.env.DEMO_PASSWORD || 'HryukersDemo2026!')
  await page.getByRole('button', { name: 'Войти в платформу' }).click()
  await expect(page.getByRole('heading', { name: 'Обзор платформы' })).toBeVisible()
  const tenants = (await (await page.request.get('/api/v1/tenants')).json()).items
  const cinema = tenants.find((item: { name: string }) => item.name.includes('Кадр'))
  const kids = tenants.find((item: { name: string }) => item.name.includes('Точка игры'))
  const sports = tenants.find((item: { name: string }) => item.name.includes('Пульс'))
  const origin = new URL(page.url()).origin
  const createSegment = async (name: string, destination: string | string[] | null, types = ['interaction']) => {
    const response = await page.request.post('/api/v1/segments', { headers: { Origin: origin }, data: {
      name, definition: { lookback_days: 30, include_all: [{ tenant_id: cinema.id, event_types: ['interaction'] }],
        exclude_any: (Array.isArray(destination) ? destination : destination ? [destination] : []).map(id => ({ tenant_id: id, event_types: types })),
        require_verified_identity: true, require_complete_coverage: true },
    } })
    expect(response.ok()).toBeTruthy()
    return response.json()
  }
  const kidsSegment = await createSegment('Кино без детского центра', kids.id)
  const sportsSegment = await createSegment('Кино без покупки в спорте', sports.id, ['purchase'])
  const noDestination = await createSegment('Аудитория без исключений', null)
  const visitOnly = await createSegment('Исключён только визит', kids.id, ['visit'])
  const multiple = await createSegment('Кино без детского центра и спорта', [kids.id, sports.id])
  await page.getByRole('link', { name: 'Рекомендации', exact: true }).click()
  await page.getByRole('button', { name: 'Добавить правило' }).click()
  const segment = page.getByRole('combobox', { name: 'Кого приглашаем', exact: true })
  const destination = page.getByRole('combobox', { name: 'Куда приглашаем', exact: true })
  const summary = page.getByRole('region', { name: 'Условия аудитории' })
  await segment.selectOption(kidsSegment.id)
  await expect(summary).toContainText(cinema.name)
  await expect(summary).toContainText(kids.name)
  await expect(summary).toContainText('30 дней')
  await expect(destination).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Куда приглашаем', exact: true })).toContainText(kids.name)
  await page.screenshot({ path: '../../.data/qa/rule-audience.png' })
  await segment.selectOption(sportsSegment.id)
  await expect(destination).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Куда приглашаем', exact: true })).toContainText(sports.name)
  await expect(summary).toContainText('покупка')
  for (const empty of [noDestination, visitOnly]) {
    await segment.selectOption(empty.id)
    await expect(destination).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Сохранить правило' })).toBeDisabled()
    await expect(page.getByRole('status', { name: 'Совместимость назначения' })).toContainText('Добавьте в разделе')
  }
  await segment.selectOption(multiple.id)
  await expect(destination).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Сохранить правило' })).toBeDisabled()
  await expect(destination.locator('option')).toHaveCount(3)
  await destination.selectOption(kids.id)
  await segment.selectOption(kidsSegment.id)
  await page.getByLabel('Название правила', { exact: true }).fill('Приглашение после кино')
  await page.getByLabel('Заголовок предложения', { exact: true }).fill('Знакомство с детским центром')
  await page.getByRole('button', { name: 'Сохранить правило' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  const rules = (await (await page.request.get('/api/v1/recommendation-rules?limit=100')).json()).items
  const rule = rules.find((item: { name: string }) => item.name === 'Приглашение после кино')
  expect(rule.segment_id).toBe(kidsSegment.id)
  expect(rule.destination_tenant_id).toBe(kids.id)

  // A different audience for the same destination needs no offer review.
  const card = page.locator('.rule-card').filter({ has: page.getByRole('heading', { name: 'Приглашение после кино', exact: true }) })
  await card.getByRole('button', { name: 'Редактировать правило' }).click()
  await segment.selectOption(multiple.id)
  await expect(destination).toHaveValue(kids.id)
  await expect(page.getByRole('group', { name: 'Проверка предложения' })).toHaveCount(0)

  // Moving an existing offer to a different tenant keeps its text and requires review.
  await destination.selectOption(sports.id)
  const review = page.getByRole('group', { name: 'Проверка предложения' })
  await expect(review).toContainText(sports.name)
  await expect(page.getByLabel('Заголовок предложения', { exact: true })).toHaveValue('Знакомство с детским центром')
  await expect(page.getByRole('button', { name: 'Сохранить правило' })).toBeDisabled()
  // Enter cannot bypass review.
  await page.getByLabel('Название правила', { exact: true }).press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByLabel('Заголовок предложения', { exact: true }).fill('Знакомство со спорттоварами')
  await review.getByRole('checkbox').check()
  await expect(page.getByRole('button', { name: 'Сохранить правило' })).toBeEnabled()
  // A subsequent change requires a new review, including a return to the original tenant.
  await destination.selectOption(kids.id)
  await expect(review.getByRole('checkbox')).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Сохранить правило' })).toBeDisabled()
  await destination.selectOption(sports.id)
  await expect(review.getByRole('checkbox')).not.toBeChecked()
  await page.screenshot({ path: '../../.data/qa/rule-offer-review.png' })
  await review.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Сохранить правило' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  const updated = (await (await page.request.get('/api/v1/recommendation-rules?limit=100')).json()).items.find((item: { id: string }) => item.id === rule.id)
  expect(updated.segment_id).toBe(multiple.id)
  expect(updated.destination_tenant_id).toBe(sports.id)
  expect(updated.offer_title).toBe('Знакомство со спорттоварами')
})
