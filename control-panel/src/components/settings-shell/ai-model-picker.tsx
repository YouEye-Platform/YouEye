'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { AIIcon } from './ai-icon';

export type AIModelPickerOption = {
  value: string;
  modelName: string;
  creator?: string | null;
  modelIconKey?: string | null;
  providerName?: string | null;
  providerIconKey?: string | null;
  accountLabel?: string | null;
  rawModelId?: string | null;
  aliases?: string[];
};

function searchable(option: AIModelPickerOption) {
  return [
    option.modelName,
    option.creator,
    option.providerName,
    option.accountLabel,
    option.rawModelId,
    ...(option.aliases || []),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

export function AIModelPicker({ label, value, onChange, options, placeholder = 'Select model', disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: AIModelPickerOption[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const selected = options.find((option) => option.value === value);
  const visible = useMemo(() => deferredQuery
    ? options.filter((option) => searchable(option).includes(deferredQuery))
    : options, [deferredQuery, options]);

  return <div className="min-w-0 space-y-2">
    <Label>{label}</Label>
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={label} disabled={disabled} className="h-auto min-h-9 w-full min-w-0 justify-between gap-2 bg-background px-3 py-2 text-left font-normal">
          {selected ? <span className="flex min-w-0 items-center gap-2"><AIIcon className="size-5" iconKey={selected.modelIconKey} name={selected.modelName} /><span className="min-w-0"><span className="block truncate text-sm font-medium">{selected.modelName}</span>{selected.providerName && <span className="block truncate text-[11px] text-muted-foreground">{selected.providerName}{selected.accountLabel ? ` · ${selected.accountLabel}` : ''}</span>}</span></span> : <span className="truncate text-muted-foreground">{placeholder}</span>}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))] overflow-hidden p-0">
        <div className="relative border-b p-2"><Search className="pointer-events-none absolute left-5 top-4 size-4 text-muted-foreground" /><Input autoFocus aria-label={`Search ${label.toLocaleLowerCase()}`} className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model, creator, provider, alias, or route" /></div>
        <div role="listbox" aria-label={label} className="max-h-80 overflow-y-auto p-1">
          {visible.length ? visible.map((option) => <button type="button" role="option" aria-selected={option.value === value} key={option.value} className={cn('flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', option.value === value && 'bg-muted/70')} onClick={() => { onChange(option.value); setOpen(false); setQuery(''); }}>
            <AIIcon className="size-7" iconKey={option.modelIconKey} name={option.modelName} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{option.modelName}</span><span className="block truncate text-xs text-muted-foreground">{[option.creator, option.providerName, option.accountLabel].filter(Boolean).join(' · ') || option.rawModelId || 'Model route'}</span></span>
            {option.rawModelId && <span className="hidden max-w-40 truncate font-mono text-[10px] text-muted-foreground sm:block">{option.rawModelId}</span>}
            <Check className={cn('size-4 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')} />
          </button>) : <p className="p-6 text-center text-sm text-muted-foreground">No matching model routes.</p>}
        </div>
        <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">{visible.length.toLocaleString()} of {options.length.toLocaleString()} routes · ordered like Models</div>
      </PopoverContent>
    </Popover>
  </div>;
}
