import { test, expect } from '@playwright/test';
test('diagnostic manual', async ({page}) => {
 page.on('pageerror', e => console.log('PAGEERROR',e.message));
 await page.goto('/login');
 await page.locator('#login-username').fill('admin'); await page.locator('#login-password').fill('demo-only');
 await page.locator('#login-submit-btn').click(); await page.waitForURL('**/navigation');
 await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');
 async function report(label){ console.log(label,await page.evaluate(async()=>{
   const c=(await import('/src/state/controlStore.js')).useControlStore.getState();
   const r=(await import('/src/stores/robotStore.js')).useRobotStore.getState();
   const video=document.querySelector('video');
   return {now:performance.now(),gen:c.selectedGeneration,frame:c.lastFrameAt,phase:c.phase,lease:c.lease?.context,limits:c.lease?.limits,
    error:c.controlError,revoked:c.lastRevocationReason,stop:c.stopUnconfirmed,mode:r.snapshot?.mode,heartbeat:c.heartbeatReceivedAt,
    video: {time:video?.currentTime,paused:video?.paused,rect:video?.getBoundingClientRect().toJSON()},
    joystick:document.querySelector('[data-testid="navigation-joystick"]')?.getBoundingClientRect().toJSON()}; }));}
 await report('BEFORE');
 await page.getByTestId('manual-mode-toggle').click(); await report('AFTER');
 await page.waitForTimeout(200); await report('READY');
 const stick=page.getByTestId('navigation-joystick'); await stick.scrollIntoViewIfNeeded();
 const b=await stick.boundingBox(); await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down();
 await page.mouse.move(b.x+b.width/2,b.y+b.height*0.18,{steps:4}); await report('POINTER');
 await page.waitForTimeout(200); await report('HOLD'); await page.mouse.up();
});
