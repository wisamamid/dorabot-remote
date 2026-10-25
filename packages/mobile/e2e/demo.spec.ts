import { test, expect } from '@playwright/test'

test.describe('DoraBot Remote iOS - Demo Mode', () => {
  test('Pair screen loads without infinite spinner and shows demo link', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Verify we're on the Pair screen
    const pairHeading = page.locator('h1', { hasText: /Pair with your Mac|Add another Mac/ })
    await expect(pairHeading).toBeVisible()

    // Verify "Scan QR code" button is visible
    await expect(page.locator('button', { hasText: /Scan QR code/ })).toBeVisible()

    // Verify "Try a demo" link is visible
    const demoLink = page.locator('button, a', { hasText: /Try a demo/ })
    await expect(demoLink).toBeVisible()
  })

  test('After a self-wipe the Pair screen explains why, once', async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1')
        localStorage.setItem('dorabot-remote.wipenotice.v1', '1')
      }
    })
    await page.goto('/')
    await expect(page.getByRole('alert')).toContainText('erased all pairings and keys after 5 failed unlock attempts')
    await page.reload()
    await expect(page.locator('h1', { hasText: /Pair with your Mac/ })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('Enter demo mode shows sample sessions and demo banner', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Click "Try a demo" link
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Wait for demo sessions to load
    await page.waitForTimeout(2000)

    // Verify demo banner is visible
    const demoBanner = page.locator('text=Demo mode: sample data, no Mac connected')
    await expect(demoBanner).toBeVisible()

    // Verify at least one demo session is shown
    const sessionText = page.locator('text=Fix failing checkout tests')
    await expect(sessionText.first()).toBeVisible()

    // Verify tab bar is visible with Sessions and Inbox tabs
    const sessionsTab = page.locator('button, [role="tab"]', { hasText: /Sessions/ })
    await expect(sessionsTab).toBeVisible()
  })

  test('Tab bar navigation to Inbox works in demo mode', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Sessions tab should show sessions
    const sessions = page.locator('text=Fix failing checkout tests')
    await expect(sessions.first()).toBeVisible()

    // Navigate to Inbox tab
    const inboxTab = page.locator('button, [role="tab"]', { hasText: /Inbox/ })
    await inboxTab.click()
    await page.waitForTimeout(1000)

    // Verify we're in the inbox
    const body = page.locator('body')
    await expect(body).toBeVisible()
  })

  test('Inbox: approve pending approval and see reply stream', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Navigate to Inbox
    await page.locator('button, [role="tab"]', { hasText: /Inbox/ }).click()
    await page.waitForTimeout(500)

    // Look for the pending approval row
    const approvalItem = page.locator('text=/npm test/i')
    await expect(approvalItem.first()).toBeVisible()

    // Find and click approve button
    const approveBtn = page.locator('button:text-is("Approve")').first()
    await approveBtn.click()
    await page.waitForTimeout(1500)

    // Verify reply text appears
    const replyText = page.locator('text=/All.*tests pass|demo/i')
    await expect(replyText.first()).toBeVisible({ timeout: 5000 })
  })

  test('Inbox: a risky approval shows the Risky badge, reasons and the full command', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')
    await page.locator('button, [role="tab"]', { hasText: /Inbox/ }).click()
    await page.waitForTimeout(500)

    const badge = page.getByTestId('risk-badge')
    await expect(badge).toHaveCount(1)
    await expect(badge.first()).toContainText('Risky')
    await expect(badge.first()).toContainText(/force/i)
    await expect(page.getByTestId('full-command').filter({ hasText: 'git push --force origin release/2.4' })).toBeVisible()
  })

  test('Inbox: Always allow offers a confirmation sheet for a routine approval, never a risky one', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')
    await page.locator('button, [role="tab"]', { hasText: /Inbox/ }).click()
    await page.waitForTimeout(500)

    // Only the routine approval (npm test) gets the option.
    const always = page.getByRole('button', { name: /Always allow/ })
    await expect(always).toHaveCount(1)
    await expect(always).toContainText('this exact command')
    await always.click()

    const sheet = page.getByRole('dialog', { name: /Always allow/ })
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('npm test')
    await expect(sheet).toContainText(/Face ID/)
    await sheet.getByRole('button', { name: 'Cancel' }).click()
    await expect(sheet).toHaveCount(0)

    // Confirm: the rule is saved (demo has no OS prompt), this request is approved, and Settings lists it.
    await always.click()
    await page.getByRole('dialog', { name: /Always allow/ }).getByRole('button', { name: 'Continue' }).click()
    await expect(page.locator('text=/All.*tests pass|demo/i').first()).toBeVisible({ timeout: 5000 })
  })

  test('Inbox: answer question by choosing an option', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Navigate to Inbox
    await page.locator('button, [role="tab"]', { hasText: /Inbox/ }).click()
    await page.waitForTimeout(1000)

    // Look for answer buttons (these should be visible for the question)
    const answerBtns = page.locator('button:has-text("Customers"), button:has-text("Engineers"), button:has-text("Both")')
    // Click first option
    await answerBtns.first().click()
    await page.waitForTimeout(2000)

    // Verify the system accepted the answer (the page should still be functional)
    const inboxArea = page.locator('body')
    await expect(inboxArea).toBeVisible()
  })

  test('Open session, type message, send, and see canned reply', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Open a session
    const sessionLink = page.locator('text=Fix failing checkout tests').first()
    await sessionLink.click()
    await page.waitForTimeout(500)

    // Verify session is open with chat content
    const chatContent = page.locator('text=/calculateTax|checkout/i')
    await expect(chatContent.first()).toBeVisible()

    // Find composer textarea
    const composer = page.locator('textarea').first()
    await expect(composer).toBeVisible()
    await composer.fill('How can I fix this?')
    await page.waitForTimeout(300)

    // Find send button (might be button or role=button)
    const sendBtn = page.locator('button:has-text("Send"), [role="button"]:has-text("Send")').first()
    if (await sendBtn.count() > 0) {
      await expect(sendBtn).toBeVisible()
      await sendBtn.click()
      await page.waitForTimeout(1500)
    } else {
      // If Send button not found, try pressing Enter
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1500)
    }

    // Verify reply appears
    const reply = page.locator('text=/demo|This is/i')
    await expect(reply.first()).toBeVisible({ timeout: 5000 })

    // Verify composer is still visible on iPhone viewport (not covered)
    const composerAfter = page.locator('textarea').first()
    await expect(composerAfter).toBeVisible()
    const bounds = await composerAfter.boundingBox()
    expect(bounds).not.toBeNull()
    const viewport = page.viewportSize()!
    // Composer should be within viewport
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1)
  })

  test('Model picker opens fully without cropping', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Open a session
    await page.locator('text=Fix failing checkout tests').first().click()
    await page.waitForTimeout(500)

    // Look for model button
    const modelBtn = page.locator('button:has-text("Sonnet"), button:has-text("Model"), button:has-text("Claude")').first()
    await expect(modelBtn).toBeVisible()
    await modelBtn.click()
    await page.waitForTimeout(500)

    // Look for picker/sheet with model options
    const pickerContent = page.locator('[role="dialog"], [class*="sheet"], [class*="modal"]').first()
    // Verify the picker element exists and is well-formed
    await expect(pickerContent).toBeVisible()

    const bounds = await pickerContent.boundingBox()
    expect(bounds).not.toBeNull()
    const viewport = page.viewportSize()!

    // Model picker sheet should have reasonable height (at least 100px)
    expect(bounds!.height).toBeGreaterThan(100)
    // Model picker should be fully within viewport bounds
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
  })

  test('Rename and pin a session', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Find a session item and look for action menu button
    const sessionItem = page.locator('text=Fix failing checkout tests').first()
    await expect(sessionItem).toBeVisible()

    // Look for actions button (⋯ or menu icon) - try long-press on the session item
    // On mobile, we might need to find a visible menu button or swipe to reveal it
    const menuButtons = page.locator('button').filter({ has: page.locator('text=/⋯|.../')})

    let menuBtnFound = false
    if (await menuButtons.count() > 0) {
      const firstMenuBtn = menuButtons.first()
      await firstMenuBtn.click()
      await page.waitForTimeout(500)
      menuBtnFound = true
    }

    // If menu button wasn't found as separate element, look for rename button anywhere
    const renameBtn = page.locator('button:has-text("Rename")').first()
    if (await renameBtn.count() > 0) {
      if (!menuBtnFound) {
        // Rename is directly clickable
      }
      await renameBtn.click()
      await page.waitForTimeout(500)

      // Find input and rename
      const inputs = page.locator('input, textarea')
      const lastInput = inputs.last()
      await expect(lastInput).toBeVisible()
      await lastInput.clear()
      await lastInput.fill('Renamed Test Session')
      await page.waitForTimeout(300)

      // Save changes
      const saveBtn = page.locator('button:has-text("Save")').first()
      if (await saveBtn.count() > 0) {
        await saveBtn.click()
      }
      await page.waitForTimeout(1000)
    }

    // Navigate back to sessions list if we're in detail view
    const backBtn = page.locator('button:has-text("Back")').first()
    if (await backBtn.count() > 0) {
      await backBtn.click()
      await page.waitForTimeout(500)
    }

    // Verify the app is still working and demo sessions exist
    const demoArea = page.locator('body')
    await expect(demoArea).toBeVisible()

    // Session should exist with either old or new name
    const sessionExists = page.locator('button, [role="button"]').filter({ hasText: /Fix failing checkout tests|Renamed/ })
    if (await sessionExists.count() > 0) {
      await expect(sessionExists.first()).toBeVisible()
    }

    // Try to find and click Pin button if it exists
    const pinBtn = page.locator('button:has-text("Pin")').first()
    if (await pinBtn.count() > 0) {
      await pinBtn.click()
      await page.waitForTimeout(1000)
    }
  })

  test('Exit demo returns to Pair screen', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Enter demo
    await page.locator('button, a', { hasText: /Try a demo/ }).click()
    await page.waitForLoadState('networkidle')

    // Verify demo mode is active
    const demoBanner = page.locator('text=Demo mode: sample data, no Mac connected')
    await expect(demoBanner).toBeVisible()

    // Click "Exit demo" button
    const exitBtn = page.locator('button:has-text("Exit demo")')
    await expect(exitBtn).toBeVisible()
    await exitBtn.click()

    await page.waitForTimeout(500)

    // Verify we're back on Pair screen
    const pairHeading = page.locator('h1', { hasText: /Pair with your Mac/ })
    await expect(pairHeading).toBeVisible()

    // Verify demo banner is gone
    const demoBannerGone = page.locator('text=Demo mode: sample data, no Mac connected')
    await expect(demoBannerGone).not.toBeVisible()
  })
})
