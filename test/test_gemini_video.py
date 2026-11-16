"""Offline tests: python3 -m unittest discover -s test -p 'test_gemini_video.py'."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

spec = importlib.util.spec_from_file_location("gemini_video", Path(__file__).parents[1]/"scripts/gemini-video.py")
video = importlib.util.module_from_spec(spec)
spec.loader.exec_module(video)


def arguments(source):
    return video.parser().parse_args([str(source)])


ANSWER = {"candidates": [{"content": {"parts": [{"text": "private thought", "thought": True},
                                            {"text": "红色画面"}]}, "finishReason": "STOP"}],
          "usageMetadata": {"totalTokenCount": 10}}
FILE = {"name": "files/test123", "uri": video.API+"files/test123", "mimeType": "video/mp4", "state": "ACTIVE"}


class VideoTests(unittest.TestCase):
    def test_youtube_and_spoofed_urls(self):
        self.assertEqual(video.youtube_url("https://youtu.be/abcdefghijk?t=2"),
                         "https://www.youtube.com/watch?v=abcdefghijk")
        for source in ("https://youtube.com.evil.test/watch?v=abcdefghijk", "http://youtu.be/abcdefghijk",
                       "https://x.com/user/status/1", "https://youtu.be/a", "https://user@youtu.be/abcdefghijk"):
            with self.subTest(source=source), self.assertRaises(video.VideoError):
                video.youtube_url(source)

    def test_no_command_execution_from_env_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"env"
            path.write_text('OTHER_KEY=private\nGEMINI_KEY="$(echo never-execute)"\n')
            self.assertEqual(video.env_file_key(path), "$(echo never-execute)")

    def test_youtube_no_upload_and_clip_preserved(self):
        client = Mock()
        client.request.return_value = (ANSWER, {})
        args = arguments("https://youtu.be/abcdefghijk")
        args.start, args.end, args.fps = 10, 30, 0.5
        result = video.analyze(client, args)
        client.upload.assert_not_called()
        self.assertEqual(client.request.call_count, 1)
        self.assertEqual(result["text"], "红色画面")
        body = client.request.call_args.args[2]
        self.assertEqual(body["contents"][0]["parts"][0]["videoMetadata"],
                         {"fps": 0.5, "startOffset": "10s", "endOffset": "30s"})
        self.assertEqual(result["usage"]["totalTokenCount"], 10)

    def test_stream_upload_not_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"video.mp4"
            path.write_bytes(b"fake video")
            client = video.Client("fake-key")
            def request(url, method, body, headers):
                if headers.get("X-Goog-Upload-Command") == "start":
                    return {}, {"X-Goog-Upload-URL": video.API+"upload-test"}
                self.assertTrue(hasattr(body, "read"))
                self.assertEqual(body.read(), b"fake video")
                self.assertEqual(headers["Content-Length"], "10")
                return {"file": FILE}, {}
            with patch.object(client, "request", side_effect=request):
                self.assertEqual(client.upload(path), FILE)

    def test_processing_and_cleanup(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4") as source:
            client = Mock(timeout=10)
            client.upload.return_value = {**FILE, "state": "PROCESSING"}
            client.request.side_effect = [(FILE, {}), (ANSWER, {}), ({}, {})]
            with patch.object(video.time, "sleep"):
                self.assertEqual(video.analyze(client, arguments(source.name))["text"], "红色画面")
            self.assertEqual(client.request.call_args.args, (video.API+"files/test123", "DELETE"))

    def test_failed_processing_cleanup(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4") as source:
            client = Mock(timeout=10)
            client.upload.return_value = {**FILE, "state": "FAILED"}
            with self.assertRaisesRegex(video.VideoError, "预处理失败"):
                video.analyze(client, arguments(source.name))
            client.request.assert_called_once_with(video.API+"files/test123", "DELETE", timeout=30)

    def test_quota_failure_no_retry_cleanup(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4") as source:
            client = Mock(timeout=10)
            client.upload.return_value = FILE
            client.request.side_effect = [video.VideoError("HTTP 429"), ({}, {})]
            with self.assertRaisesRegex(video.VideoError, "429"):
                video.analyze(client, arguments(source.name))
            self.assertEqual(client.request.call_count, 2)  # one generate, one delete

    def test_http_error_redacts_key_and_never_retries(self):
        client = video.Client("secret-fake-key")
        error = urllib.error.HTTPError(video.API, 429, "quota", {}, io.BytesIO(
            json.dumps({"error": {"message": "quota secret-fake-key"}}).encode()))
        with patch.object(client.opener, "open", side_effect=error) as opened:
            with self.assertRaises(video.VideoError) as caught:
                client.request(video.API)
            self.assertNotIn("secret-fake-key", str(caught.exception))
            self.assertIn("未重试", str(caught.exception))
            self.assertEqual(opened.call_count, 1)

    def test_auth_never_sent_to_other_hosts(self):
        client = video.Client("fake-key")
        with patch.object(client.opener, "open") as opened:
            for url in ("https://evil.test/upload", "https://generativelanguage.googleapis.com.evil.test/",
                        "http://generativelanguage.googleapis.com/", "https://user@generativelanguage.googleapis.com/"):
                with self.assertRaises(video.VideoError):
                    client.request(url)
            opened.assert_not_called()
        with self.assertRaises(video.VideoError):
            video.file_url("files/../models")

    def test_no_text_is_explicit_failure(self):
        client = Mock()
        client.request.return_value = ({"promptFeedback": {"blockReason": "SAFETY"}}, {})
        with self.assertRaisesRegex(video.VideoError, "SAFETY"):
            video.analyze(client, arguments("https://youtu.be/abcdefghijk"))

    def test_invalid_range_never_calls_api(self):
        with patch.object(video, "Client") as client, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(video.main(["video.mp4", "--start", "20", "--end", "10"]), 1)
            self.assertEqual(video.main(["video.mp4", "--fps", "nan"]), 1)
            client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
