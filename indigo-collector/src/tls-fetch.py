"""Fetch IndiGo page resources in one persistent curl_cffi session.

The caller sends JSON lines on stdin and receives JSON lines on stdout.
Cookies and authorization headers stay in memory and are never printed.
"""

import base64
import json
import re
import sys
from urllib.parse import quote, urlsplit, urlunsplit

from curl_cffi import CurlHttpVersion, requests


def fetch(item, session):
    path = urlsplit(item['url']).path
    public_resource = (path == '/' or
                       path.startswith('/etc.clientlibs/') or
                       path.startswith('/booking/') or
                       path.startswith('/login/') or path.startswith('/login-sso/') or
                       path.startswith('/search-results/') or
                       path.startswith('/skyplus-design-system-app/') or
                       path.startswith('/content/api/') or
                       path.startswith('/content/skyplus6e/in/en.theme.') or
                       path == '/content/skyplus6e/in/en/book/flight-select.html' or
                       path == '/book/flight-select.html' or
                       path == '/bookingwidgetsearchengine/search' or
                       path == '/v1/setting/indigowidgets')
    headers = {
        key: value for key, value in item['headers'].items()
        if key.lower() not in {'host', 'content-length', 'connection', 'accept-encoding'}
        and not (public_resource and key.lower() == 'cookie')
        and not (public_resource and
                 (key.lower() == 'user-agent' or key.lower().startswith('sec-ch-ua')))
    }
    if path == '/' and item['method'] == 'GET':
        headers = {key: value for key, value in headers.items()
                   if key.lower() == 'accept'}
    proxy = item.get('proxy')
    if proxy:
        proxy_url = proxy['server']
        if proxy.get('username'):
            parts = urlsplit(proxy_url)
            username = quote(proxy['username'], safe='')
            password = quote(proxy.get('password', ''), safe='')
            proxy_url = urlunsplit((parts.scheme, f'{username}:{password}@{parts.netloc}', parts.path, '', ''))
    try:
        response = session.request(
            item['method'], item['url'], data=base64.b64decode(item.get('body', '')),
            headers=headers, timeout=10, discard_cookies=True,
            proxy=proxy_url if proxy else None,
            http_version=CurlHttpVersion.V1_1 if item.get('httpVersion') == 'v1.1' else None,
        )
        return {
            'id': item['id'],
            'status': response.status_code,
            'contentType': response.headers.get('content-type', 'application/octet-stream'),
            'body': base64.b64encode(response.content).decode('ascii'),
            'finalUrl': response.url,
            'corsHeaders': {key: value for key, value in response.headers.items()
                            if key.lower() in {'access-control-allow-origin',
                                               'access-control-allow-credentials',
                                               'access-control-expose-headers', 'vary'}},
            'cookies': ([{
                'name': cookie.name,
                'value': cookie.value,
                'domain': cookie.domain,
                'path': cookie.path,
                'secure': cookie.secure,
                'httpOnly': 'HttpOnly' in cookie._rest,
                'expires': cookie.expires if cookie.expires is not None else -1,
            } for cookie in response.cookies.jar] if path == '/' else []),
        }
    except Exception as error:
        detail = re.sub(r'://[^/@\s]+@', '://[redacted]@', str(error))
        return {'id': item['id'], 'error': f'{type(error).__name__}: {detail}'}


def main():
    session = requests.Session(impersonate='chrome')
    requests_on_session = 0
    try:
        for line in sys.stdin:
            if requests_on_session >= 40:
                session.close()
                session = requests.Session(impersonate='chrome')
                requests_on_session = 0
            item = json.loads(line)
            print(json.dumps(fetch(item, session)), flush=True)
            requests_on_session += 1
    finally:
        session.close()


if __name__ == '__main__':
    main()
