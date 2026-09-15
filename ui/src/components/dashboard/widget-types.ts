export interface AppWidgetDef {
  id: string;
  widget_id: string;
  name: string;
  description: string;
  app_url: string | null;
  embed_path: string;
  default_size: { width: number; height: number };
  min_size?: { width: number; height: number };
  max_size?: { width: number; height: number };
  app_id: string;
  app_name: string;
}
