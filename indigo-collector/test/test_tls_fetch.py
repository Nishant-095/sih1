import base64
import importlib.util
import pathlib
import unittest


source = pathlib.Path(__file__).resolve().parents[1] / 'src' / 'tls-fetch.py'
spec = importlib.util.spec_from_file_location('tls_fetch', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeResponse:
    status_code = 200
    content = b'ok'
    headers = {'content-type': 'text/plain'}

    def __init__(self, url):
        self.url = url
        self.cookies = type('Cookies', (), {'jar': []})()


class FakeSession:
    def request(self, method, url, **kwargs):
        self.method = method
        self.url = url
        self.kwargs = kwargs
        self.response = FakeResponse(url)
        return self.response


class BridgeRequestTest(unittest.TestCase):
    def setUp(self):
        self.session = FakeSession()
        self.item = {'id': 1, 'method': 'GET', 'body': '', 'proxy': None,
                     'headers': {'cookie': 'session=private', 'user_key': 'public-key',
                                 'host': 'www.goindigo.in'}}

    def test_public_code_and_airport_lookup_do_not_send_browser_cookie(self):
        for url in (
            'https://www.goindigo.in/etc.clientlibs/skyplus6ev2/clientlibs/site.css',
            'https://app-prod-skyplus6e.goindigo.in/search-results/remoteEntry.js',
            'https://api-prod-skyplus.goindigo.in/bookingwidgetsearchengine/search',
        ):
            with self.subTest(url=url):
                module.fetch({**self.item, 'url': url}, self.session)
                self.assertNotIn('cookie', self.session.kwargs['headers'])
                self.assertEqual(self.session.kwargs['headers']['user_key'], 'public-key')

    def test_public_code_omits_headless_browser_fingerprint(self):
        module.fetch({**self.item,
                      'url': 'https://www.goindigo.in/etc.clientlibs/site.js',
                      'headers': {**self.item['headers'], 'user-agent': 'HeadlessChrome',
                                  'sec-ch-ua': 'HeadlessChrome'}}, self.session)
        self.assertNotIn('user-agent', self.session.kwargs['headers'])
        self.assertNotIn('sec-ch-ua', self.session.kwargs['headers'])

    def test_dynamic_request_keeps_session_and_body(self):
        body = base64.b64encode(b'{"route":"DEL-BOM"}').decode()
        module.fetch({**self.item, 'method': 'POST', 'body': body,
                      'url': 'https://api-prod-skyplus.goindigo.in/v2/flight/search'}, self.session)
        self.assertEqual(self.session.kwargs['headers']['cookie'], 'session=private')
        self.assertEqual(self.session.kwargs['data'], b'{"route":"DEL-BOM"}')

    def test_opt_in_flight_post_uses_http1_and_preserves_cors(self):
        body = base64.b64encode(b'{"route":"DEL-BOM"}').decode()
        result = module.fetch({**self.item, 'method': 'POST', 'body': body,
                               'httpVersion': 'v1.1',
                               'url': 'https://api-prod-flight-skyplus6e.goindigo.in/v2/flight/search'},
                              self.session)
        self.assertEqual(self.session.kwargs['http_version'], module.CurlHttpVersion.V1_1)
        self.assertEqual(self.session.kwargs['headers']['cookie'], 'session=private')
        self.assertEqual(self.session.kwargs['data'], b'{"route":"DEL-BOM"}')
        self.assertEqual(result['corsHeaders'], {})

    def test_homepage_uses_browser_transport_headers(self):
        module.fetch({**self.item, 'url': 'https://www.goindigo.in/',
                      'headers': {**self.item['headers'],
                                  'accept': 'text/html',
                                  'user-agent': 'HeadlessChrome',
                                  'sec-ch-ua': 'HeadlessChrome'}}, self.session)
        self.assertEqual(self.session.kwargs['headers'], {'accept': 'text/html'})


if __name__ == '__main__':
    unittest.main()
