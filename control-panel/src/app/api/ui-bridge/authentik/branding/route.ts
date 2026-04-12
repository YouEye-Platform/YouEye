/**
 * Authentik Branding Bridge Endpoint
 *
 * POST /api/ui-bridge/authentik/branding
 *
 * Receives theme CSS from YouEye UI and pushes it to Authentik's
 * default brand as custom CSS. Also generates a WordArt SVG logo
 * and updates authentication flow titles.
 *
 * Auth: UI Bridge token (X-UI-Bridge-Token header)
 */

import { NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { listBrands, updateBrand, updateFlow } from '@/lib/authentik/client';
import { execShell } from '@/lib/incus/server';
import { generateWordArtSVG } from '@/lib/authentik/wordart-svg';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/** Flow slugs whose title should reflect the site name */
const AUTH_FLOW_SLUGS = [
  'default-authentication-flow',
  'default-source-authentication',
  'initial-setup',
];

export async function POST(request: Request) {
  // Validate bridge token
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { css, siteName, siteNameStyle, fontSlug } = body as {
      css?: string;
      siteName?: string;
      siteNameStyle?: Record<string, unknown>;
      fontSlug?: string;
    };

    if (!css) {
      return NextResponse.json(
        { error: 'css field is required' },
        { status: 400 }
      );
    }

    // Find the default Authentik brand
    const brandsResponse = await listBrands();
    const defaultBrand = brandsResponse.results.find((b) => b.default);

    if (!defaultBrand) {
      console.error('[authentik-branding] No default brand found');
      return NextResponse.json(
        { error: 'No default Authentik brand found' },
        { status: 404 }
      );
    }

    // Build the update payload
    const updateData: Partial<{
      branding_title: string;
      branding_logo: string;
      branding_favicon: string;
      branding_custom_css: string;
    }> = {
      branding_custom_css: css,
    };

    if (siteName) {
      updateData.branding_title = siteName;
    }

    // Generate WordArt SVG for Authentik's branding_logo.
    // This SVG is used in two places:
    //   1. Login flow: hidden (transparent via font-size:0 on parent), replaced by
    //      CSS ::part(branding)::after pseudo-element for pixel-perfect matching.
    //   2. Dashboard/sidebar header: displayed as <img> — the SVG gives a close
    //      approximation of the WordArt style with embedded fonts.
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
        console.warn('[authentik-branding] Non-fatal: SVG logo generation failed:', svgErr);
        updateData.branding_logo = '/static/dist/assets/icons/icon.png';
      }
    } else {
      updateData.branding_logo = '/static/dist/assets/icons/icon.png';
    }

    // Copy font files into Authentik so @font-face src: url() paths resolve.
    // Inter fonts are always needed; the branding font is copied when fontSlug is set.
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
          await execShell(
            'youeye-authentik',
            `printf '%s' '${b64}' | base64 -d > ${destDir}/${file}`
          );
        }
        console.log(`[authentik-branding] Copied ${files.length} font files for ${slug}`);
      } catch (fontErr) {
        console.warn(`[authentik-branding] Non-fatal: font copy failed for ${slug}:`, fontErr);
      }
    }

    // Update the brand
    const updated = await updateBrand(defaultBrand.brand_uuid, updateData);

    console.log(
      `[authentik-branding] Updated brand "${updated.branding_title}" with custom CSS (${css.length} chars)`
    );

    // Update authentication flow titles to match the site name
    if (rawSiteName) {
      const flowTitle = `Welcome home!`;
      for (const slug of AUTH_FLOW_SLUGS) {
        try {
          await updateFlow(slug, { title: flowTitle });
        } catch {
          // Some flows may not exist — non-fatal
        }
      }
      console.log(`[authentik-branding] Updated flow titles to "${flowTitle}"`);
    }

    return NextResponse.json({
      success: true,
      brand: updated.branding_title,
      cssLength: css.length,
    });
  } catch (error) {
    console.error('[authentik-branding] Error updating Authentik brand:', error);
    return NextResponse.json(
      {
        error: 'Failed to update Authentik branding',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
