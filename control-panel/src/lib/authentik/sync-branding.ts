/**
 * Authentik Branding Sync
 *
 * Pushes branding (CSS, logo SVG, favicon PNG, fonts) to Authentik.
 * Called from:
 *   - /api/ui/branding PUT (after embed Save)
 *   - /api/ui-bridge/authentik/branding POST (direct embed call)
 */

import { listBrands, updateBrand, updateFlow, ensureAvatarSettings } from './client';
import { execShell } from '@/lib/incus/server';
import { generateWordArtSVG } from './wordart-svg';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const AUTH_FLOW_SLUGS = [
  'default-authentication-flow',
  'default-source-authentication',
  'initial-setup',
];

export interface SyncBrandingParams {
  css: string;
  siteName?: string;
  siteNameStyle?: Record<string, unknown>;
  fontSlug?: string;
}

export async function syncBrandingToAuthentik(params: SyncBrandingParams): Promise<{ success: boolean; error?: string }> {
  const { css, siteName, siteNameStyle, fontSlug } = params;

  try {
    const brandsResponse = await listBrands();
    const defaultBrand = brandsResponse.results.find((b) => b.default);

    if (!defaultBrand) {
      console.error('[authentik-sync] No default brand found');
      return { success: false, error: 'No default Authentik brand found' };
    }

    const updateData: Partial<{
      branding_title: string;
      branding_logo: string;
      branding_favicon: string;
      branding_custom_css: string;
    }> = {
      branding_custom_css: css,
    };

    // Push rendered favicon to Authentik
    try {
      const uiBase = `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;
      const faviconRes = await fetch(`${uiBase}/api/v1/branding/icon?size=192`, {
        signal: AbortSignal.timeout(5000),
      });
      if (faviconRes.ok) {
        const faviconBuf = Buffer.from(await faviconRes.arrayBuffer());
        const faviconB64 = faviconBuf.toString('base64');
        // Chunked write for large icons
        const CHUNK = 65536;
        if (faviconB64.length > CHUNK) {
          await execShell('youeye-authentik', `mkdir -p /web/dist/assets/icons && rm -f /web/dist/assets/icons/youeye-favicon.png.b64`);
          for (let off = 0; off < faviconB64.length; off += CHUNK) {
            const chunk = faviconB64.slice(off, off + CHUNK);
            await execShell('youeye-authentik', `printf '%s' '${chunk}' >> /web/dist/assets/icons/youeye-favicon.png.b64`);
          }
          await execShell('youeye-authentik', `base64 -d /web/dist/assets/icons/youeye-favicon.png.b64 > /web/dist/assets/icons/youeye-favicon.png && rm /web/dist/assets/icons/youeye-favicon.png.b64`);
        } else {
          await execShell(
            'youeye-authentik',
            `mkdir -p /web/dist/assets/icons && printf '%s' '${faviconB64}' | base64 -d > /web/dist/assets/icons/youeye-favicon.png`
          );
        }
        updateData.branding_favicon = '/static/dist/assets/icons/youeye-favicon.png';
        console.log('[authentik-sync] Pushed custom favicon to Authentik');
      }
    } catch (favErr) {
      console.warn('[authentik-sync] Non-fatal: favicon push failed:', favErr);
    }

    if (siteName) {
      updateData.branding_title = siteName;
    }

    // Generate WordArt SVG for branding_logo
    const rawSiteName = siteName ? siteName.replace(/ ID$/, '') : undefined;
    if (rawSiteName) {
      try {
        const svg = generateWordArtSVG(rawSiteName, siteNameStyle as never);
        const escapedSvg = svg.replace(/'/g, "'\\''");
        await execShell(
          'youeye-authentik',
          `mkdir -p /web/dist/assets/icons && cat > /web/dist/assets/icons/youeye-wordart.svg << 'SVGEOF'\n${escapedSvg}\nSVGEOF`
        );
        updateData.branding_logo = '/static/dist/assets/icons/youeye-wordart.svg';
      } catch (svgErr) {
        console.warn('[authentik-sync] Non-fatal: SVG logo generation failed:', svgErr);
        updateData.branding_logo = '/static/dist/assets/icons/icon.png';
      }
    } else {
      updateData.branding_logo = '/static/dist/assets/icons/icon.png';
    }

    // Copy font files into Authentik
    const fontsToSync = ['inter'];
    if (fontSlug && fontSlug !== 'inter') fontsToSync.push(fontSlug);

    for (const slug of fontsToSync) {
      try {
        const srcDir = join(process.cwd(), 'public', 'fonts', slug);
        if (!existsSync(srcDir)) continue;
        const destDir = `/web/dist/assets/fonts/${slug}`;
        await execShell('youeye-authentik', `mkdir -p ${destDir}`);
        const files = readdirSync(srcDir).filter(f => /\.(ttf|woff2?|otf)$/.test(f));
        for (const file of files) {
          const data = readFileSync(join(srcDir, file));
          const b64 = data.toString('base64');
          const CHUNK = 65536;
          if (b64.length > CHUNK) {
            await execShell('youeye-authentik', `rm -f ${destDir}/${file}`);
            for (let off = 0; off < b64.length; off += CHUNK) {
              const chunk = b64.slice(off, off + CHUNK);
              await execShell('youeye-authentik', `printf '%s' '${chunk}' >> ${destDir}/${file}.b64`);
            }
            await execShell('youeye-authentik', `base64 -d ${destDir}/${file}.b64 > ${destDir}/${file} && rm ${destDir}/${file}.b64`);
          } else {
            await execShell('youeye-authentik', `printf '%s' '${b64}' | base64 -d > ${destDir}/${file}`);
          }
        }
        console.log(`[authentik-sync] Copied ${files.length} font files for ${slug}`);
      } catch (fontErr) {
        console.warn(`[authentik-sync] Non-fatal: font copy failed for ${slug}:`, fontErr);
      }
    }

    // Update the brand
    const updated = await updateBrand(defaultBrand.brand_uuid, updateData);
    console.log(`[authentik-sync] Updated brand "${updated.branding_title}" with CSS (${css.length} chars)`);

    // Update authentication flow titles
    if (rawSiteName) {
      const flowTitle = `Welcome home!`;
      for (const slug of AUTH_FLOW_SLUGS) {
        try {
          await updateFlow(slug, { title: flowTitle });
        } catch {
          // Some flows may not exist
        }
      }
    }

    // Ensure avatar settings
    await ensureAvatarSettings();

    return { success: true };
  } catch (error) {
    console.error('[authentik-sync] Error:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
