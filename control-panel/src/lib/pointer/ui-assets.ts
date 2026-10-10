// Keep this independent of identity code: public build assets contain no user state.
export function allowedPointerAssetPath(path: string) {
  return /^(?:manifest\.json|entry-[a-f0-9]{16}\.js|(?:styles|fonts)-[a-f0-9]{16}\.css|fonts\/[a-f0-9]{16}-[A-Za-z0-9_.-]+\.(?:woff2?|ttf|otf)|icons\/brands-[a-f0-9]{16}\/(?:[A-Za-z0-9-]+\.svg|NOTICE\.txt))$/.test(path);
}
