/**
 * App Drawer Settings — Appearance subsection
 *
 * Allows users to:
 * - Re-order apps via drag-and-drop
 * - Rename apps (per-user customization)
 * - Change app icons (upload, Lucide, emoji)
 * - Toggle app visibility
 * - Admins can "Set as server default" to write to global apps table
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Pencil,
  Eye,
  EyeOff,
  Check,
  X,
  Loader2,
  RotateCcw,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconPicker, type IconPickerResult } from "@/components/icon-picker";

// ─── Types ────────────────────────────────────────────────────

interface DrawerAppConfig {
  id: string;
  name: string;
  original_name: string;
  icon: string | null;
  custom_icon_url: string | null;
  visible: boolean;
  order: number;
  status: string | null;
  url: string | null;
}

interface AppDrawerSettingsProps {
  isAdmin?: boolean;
}

// ─── Sortable Item ────────────────────────────────────────────

function SortableAppItem({
  app,
  onEdit,
  onToggleVisibility,
}: {
  app: DrawerAppConfig;
  onEdit: (app: DrawerAppConfig) => void;
  onToggleVisibility: (appId: string, visible: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: app.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };

  const displayIcon = app.custom_icon_url || app.icon;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-card transition-shadow ${
        isDragging ? "shadow-lg ring-2 ring-primary/20" : ""
      } ${!app.visible ? "opacity-50" : ""}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing touch-none text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* Icon preview */}
      <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-sm overflow-hidden shrink-0">
        {displayIcon?.startsWith("emoji:") ? (
          <span className="text-base">{displayIcon.slice(6)}</span>
        ) : displayIcon?.startsWith("http") || displayIcon?.startsWith("/") ? (
          <img
            src={app.custom_icon_url ?? displayIcon}
            alt=""
            className="w-8 h-8 rounded-lg object-cover"
          />
        ) : (
          <span className="text-foreground/80 text-xs font-medium">
            {app.name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>

      {/* Name */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{app.name}</p>
        {app.name !== app.original_name && (
          <p className="text-[10px] text-muted-foreground truncate">
            {app.original_name}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onToggleVisibility(app.id, !app.visible)}
          title={app.visible ? "Hide from drawer" : "Show in drawer"}
        >
          {app.visible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onEdit(app)}
          title="Edit name & icon"
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Edit Dialog ──────────────────────────────────────────────

function EditAppDialog({
  app,
  isAdmin,
  onSave,
  onClose,
}: {
  app: DrawerAppConfig;
  isAdmin: boolean;
  onSave: (
    appId: string,
    data: { customName?: string | null; iconValue?: string | null; iconType?: string },
    setAsDefault?: boolean
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [customName, setCustomName] = useState(app.name);
  const [selectedIcon, setSelectedIcon] = useState<IconPickerResult | null>(null);
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const nameChanged = customName.trim() !== app.original_name;
      await onSave(
        app.id,
        {
          customName: nameChanged ? customName.trim() : null,
          iconValue: selectedIcon?.value ?? undefined,
          iconType: selectedIcon?.type ?? undefined,
        },
        setAsDefault
      );
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await onSave(app.id, { customName: null, iconValue: null, iconType: undefined });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const currentIconForPicker = app.custom_icon_url ?? app.icon;

  return (
    <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Edit {app.original_name}</DialogTitle>
      </DialogHeader>

      <div className="space-y-4">
        {/* Custom Name */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Display Name</label>
          <Input
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder={app.original_name}
          />
        </div>

        {/* Icon Picker */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Icon</label>
          <IconPicker
            currentIcon={currentIconForPicker}
            onSelect={setSelectedIcon}
            compact
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={saving}
            className="gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Save
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

// ─── Main Component ───────────────────────────────────────────

export function AppDrawerSettings({ isAdmin = false }: AppDrawerSettingsProps) {
  const [apps, setApps] = useState<DrawerAppConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingApp, setEditingApp] = useState<DrawerAppConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const fetchApps = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/apps/drawer");
      if (!res.ok) return;
      const data = await res.json();
      // Show ALL apps (including hidden) for management
      setApps(
        data.apps.sort(
          (a: DrawerAppConfig, b: DrawerAppConfig) =>
            (a.order ?? 999) - (b.order ?? 999)
        )
      );
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  // ─── Drag end: reorder ─────────────────────────────────

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = apps.findIndex((a) => a.id === active.id);
    const newIndex = apps.findIndex((a) => a.id === over.id);
    const reordered = arrayMove(apps, oldIndex, newIndex);
    setApps(reordered);

    // Persist new order for all moved items
    setSaving(true);
    try {
      await Promise.all(
        reordered.map((app, idx) =>
          fetch(`/api/v1/apps/drawer/${app.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: idx }),
          })
        )
      );
    } finally {
      setSaving(false);
    }
  };

  // ─── Toggle visibility ─────────────────────────────────

  const handleToggleVisibility = async (appId: string, visible: boolean) => {
    setApps((prev) =>
      prev.map((a) => (a.id === appId ? { ...a, visible } : a))
    );

    await fetch(`/api/v1/apps/drawer/${appId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible }),
    });
  };

  // ─── Save edit (name + icon) ───────────────────────────

  const handleSaveEdit = async (
    appId: string,
    data: { customName?: string | null; iconValue?: string | null; iconType?: string },
    setAsDefault?: boolean
  ) => {
    // Build per-user update
    const userUpdate: Record<string, unknown> = {};
    if (data.customName !== undefined) {
      userUpdate.custom_name = data.customName;
    }
    if (data.iconValue !== undefined) {
      if (data.iconValue === null) {
        // Reset
        userUpdate.custom_icon_url = null;
      } else if (data.iconType === "upload") {
        userUpdate.custom_icon_url = data.iconValue;
      } else {
        // Lucide or emoji — store in custom_icon_url field as the canonical override
        userUpdate.custom_icon_url = data.iconValue;
      }
    }

    // Save per-user config
    await fetch(`/api/v1/apps/drawer/${appId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(userUpdate),
    });

    // Refresh
    await fetchApps();
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (apps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No apps installed yet. Install apps from the marketplace to customize your drawer.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">App Drawer</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Drag to reorder. Click edit to rename or change icons.
          </p>
        </div>
        {saving && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={apps.map((a) => a.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-1.5">
            {apps.map((app) => (
              <SortableAppItem
                key={app.id}
                app={app}
                onEdit={setEditingApp}
                onToggleVisibility={handleToggleVisibility}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Edit Dialog */}
      <Dialog
        open={!!editingApp}
        onOpenChange={(open) => !open && setEditingApp(null)}
      >
        {editingApp && (
          <EditAppDialog
            app={editingApp}
            isAdmin={isAdmin}
            onSave={handleSaveEdit}
            onClose={() => setEditingApp(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
