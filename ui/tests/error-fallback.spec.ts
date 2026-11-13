import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorPage from "../src/pages/_error";

test("Pages Router errors render without an App Router translation provider", () => {
  const rendered = new Set<string>();
  for (const locale of ["en", "ru", "es", "de", "fr"]) {
    for (const statusCode of [404, 500, undefined]) {
      const html = renderToStaticMarkup(createElement(ErrorPage, { statusCode, locale }));
      assert.doesNotMatch(html, /MISSING_MESSAGE|interface\.m|NextIntlClientProvider/);
      assert.match(html, /<h1/);
      if (statusCode === 404) rendered.add(html);
    }
  }
  assert.equal(rendered.size, 5, "each shipped locale has its own error message");
});

test("unsupported error locales have a safe English fallback", () => {
  const render = (locale: string) => renderToStaticMarkup(createElement(ErrorPage, { statusCode: 500, locale }));
  assert.equal(render("unsupported"), render("en"));
  assert.equal(render("ru-RU"), render("ru"));
});
