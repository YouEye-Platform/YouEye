# Identity login navigation

Starting at the YouEye dashboard initiates its OAuth authorization flow. The
identity login page carries the authorization destination in both the URL's
`return_to` query parameter and a hidden form field.

On submission, YouEye ID uses a valid form destination first, then a valid query
destination. If neither is usable, it returns to the configured dashboard after
sign-in. The dashboard URL follows the configured domain and optional UI
subdomain; request host and forwarded headers cannot choose this fallback.

Return destinations must use HTTPS at an allowed appliance origin and contain
neither URL credentials nor a fragment. Installed apps are allowed only when
their registered forward-auth configuration qualifies them. Invalid destinations
never become external redirects.

The identity hostname's root also redirects to the configured dashboard. Other
unrecognized identity paths remain unavailable. This does not expose ordinary
Control Panel routes through the identity process or bypass dashboard sign-in.
Login HTML and navigation redirects use `Cache-Control: no-store`.

If investigating a failed return, distinguish the login POST's redirect from
later authorization and callback redirects. A query parameter visible before
submission does not prove what was submitted in the form. Capture destination
paths and return-field presence without retaining passwords, cookies, OAuth
state or authorization codes.
