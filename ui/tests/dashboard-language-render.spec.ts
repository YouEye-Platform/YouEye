import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { BookmarksWidget } from "../src/components/widgets/bookmarks-widget";
import { ClockWidget } from "../src/components/widgets/clock-widget";

for (const locale of ["en", "ru", "es", "de", "fr"]) {
  test(`dashboard widgets render the chosen ${locale} messages and date`, () => {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"));
    const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(NextIntlClientProvider, {
      locale, messages, timeZone: "UTC", children: child,
    }));
    assert.ok(render(createElement(BookmarksWidget)).includes(messages.bookmarksWidget.empty));
    const clock = render(createElement(ClockWidget));
    // Russian and other languages inflect month names when a day is present.
    const month = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" })
      .formatToParts(new Date()).find(part => part.type === "month")!.value;
    assert.ok(clock.toLocaleLowerCase(locale).includes(month.toLocaleLowerCase(locale)));
  });
}
