'use client';

import Image from 'next/image';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import ai21Icon from '@/assets/ai-brands/ai21-brand-color.svg';
import anthropicIcon from '@/assets/ai-brands/anthropic.svg';
import arceeIcon from '@/assets/ai-brands/arcee-color.svg';
import awsIcon from '@/assets/ai-brands/aws-color.svg';
import ayaIcon from '@/assets/ai-brands/aya-color.svg';
import baiduIcon from '@/assets/ai-brands/baidu-color.svg';
import cerebrasIcon from '@/assets/ai-brands/cerebras-color.svg';
import chatglmIcon from '@/assets/ai-brands/chatglm-color.svg';
import claudeIcon from '@/assets/ai-brands/claude-color.svg';
import codexIcon from '@/assets/ai-brands/codex-color.svg';
import cohereIcon from '@/assets/ai-brands/cohere-color.svg';
import commandIcon from '@/assets/ai-brands/commanda-color.svg';
import deepinfraIcon from '@/assets/ai-brands/deepinfra-color.svg';
import deepseekIcon from '@/assets/ai-brands/deepseek-color.svg';
import fireworksIcon from '@/assets/ai-brands/fireworks-color.svg';
import geminiIcon from '@/assets/ai-brands/gemini-color.svg';
import gemmaIcon from '@/assets/ai-brands/gemma-color.svg';
import googleIcon from '@/assets/ai-brands/google-color.svg';
import grokIcon from '@/assets/ai-brands/grok.svg';
import groqIcon from '@/assets/ai-brands/groq.svg';
import kimiIcon from '@/assets/ai-brands/kimi.svg';
import metaIcon from '@/assets/ai-brands/meta-color.svg';
import microsoftIcon from '@/assets/ai-brands/microsoft-color.svg';
import minimaxIcon from '@/assets/ai-brands/minimax-color.svg';
import mistralIcon from '@/assets/ai-brands/mistral-color.svg';
import nvidiaIcon from '@/assets/ai-brands/nvidia-color.svg';
import openaiIcon from '@/assets/ai-brands/openai.svg';
import openrouterIcon from '@/assets/ai-brands/openrouter-color.svg';
import perplexityIcon from '@/assets/ai-brands/perplexity-color.svg';
import qwenIcon from '@/assets/ai-brands/qwen-color.svg';
import sambanovaIcon from '@/assets/ai-brands/sambanova-color.svg';
import togetherIcon from '@/assets/ai-brands/together-color.svg';
import upstageIcon from '@/assets/ai-brands/upstage-color.svg';
import xaiIcon from '@/assets/ai-brands/xai.svg';
import yiIcon from '@/assets/ai-brands/yi-color.svg';
import zhipuIcon from '@/assets/ai-brands/zhipu-color.svg';

const brandFiles = {
  '01-ai': yiIcon, '01ai': yiIcon, ai21: ai21Icon,
  alibaba: qwenIcon, anthropic: anthropicIcon, arcee: arceeIcon,
  aws: awsIcon, aya: ayaIcon, baidu: baiduIcon,
  cerebras: cerebrasIcon, chatglm: chatglmIcon, claude: claudeIcon,
  codex: codexIcon, cohere: cohereIcon, command: commandIcon,
  commanda: commandIcon, deepinfra: deepinfraIcon, deepseek: deepseekIcon,
  fireworks: fireworksIcon, gemini: geminiIcon, 'google-gemini': geminiIcon,
  gemma: gemmaIcon, google: googleIcon, grok: grokIcon, groq: groqIcon,
  kimi: kimiIcon, meta: metaIcon, 'meta-llama': metaIcon,
  microsoft: microsoftIcon, minimax: minimaxIcon, mistral: mistralIcon,
  mistralai: mistralIcon, moonshot: kimiIcon, 'moonshot-ai': kimiIcon,
  nvidia: nvidiaIcon, openai: openaiIcon, 'openai-codex': openaiIcon,
  openrouter: openrouterIcon, perplexity: perplexityIcon, qwen: qwenIcon,
  sambanova: sambanovaIcon, together: togetherIcon, upstage: upstageIcon,
  xai: xaiIcon, 'x-ai': xaiIcon, 'xai-grok': grokIcon, yi: yiIcon, zai: zhipuIcon,
  'z-ai': zhipuIcon, zhipu: zhipuIcon, zhipuai: zhipuIcon,
};
const monochromeKeys = new Set([
  'anthropic', 'grok', 'groq', 'kimi', 'moonshot', 'moonshot-ai', 'openai', 'openai-codex', 'xai', 'x-ai', 'xai-grok',
]);

export function AIIcon({ iconKey, name, className }: { iconKey?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const normalized = iconKey?.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || '';
  const file = brandFiles[normalized as keyof typeof brandFiles];
  return <span className={cn('flex size-9 shrink-0 items-center justify-center bg-transparent text-muted-foreground', className)} title={name} aria-label={name} data-icon-kind={file && !failed ? 'brand' : 'generic'}>
    {file && !failed ? <Image src={file} className={cn('size-full object-contain', monochromeKeys.has(normalized) && 'dark:invert')} alt="" width={36} height={36} unoptimized onError={() => setFailed(true)} /> : <svg aria-hidden="true" className="size-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.3 4.2a5 5 0 003.3 3.3L21 12l-4.4 1.5a5 5 0 00-3.2 3.2L12 21l-1.4-4.3a5 5 0 00-3.2-3.2L3 12l4.4-1.5a5 5 0 003.3-3.3L12 3z" /></svg>}
  </span>;
}
