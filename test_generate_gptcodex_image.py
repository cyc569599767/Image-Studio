import base64
import json
import tempfile
import unittest
from pathlib import Path

from generate_gptcodex_image import (
    build_curl_command,
    build_curl_config,
    build_payload,
    describe_response_problem,
    extract_image_result_from_sse,
    image_file_to_data_url,
    is_retryable_response,
)


PNG_BYTES = b"\x89PNG\r\n\x1a\nfake"
PNG_B64 = base64.b64encode(PNG_BYTES).decode("ascii")


def _sse(event):
    return "data: " + json.dumps(event, separators=(",", ":"))


class ExtractImageResultTests(unittest.TestCase):
    def test_build_payload_uses_selected_size_and_quality(self):
        payload = build_payload("生成海报", size="1536x1024", quality="high")

        tool = payload["tools"][0]
        content = payload["input"][0]["content"]
        self.assertEqual(tool["size"], "1536x1024")
        self.assertEqual(tool["quality"], "high")
        self.assertEqual(tool["model"], "gpt-image-2")
        self.assertEqual(tool["action"], "generate")
        self.assertEqual(content, [{"type": "input_text", "text": "生成海报"}])
        self.assertTrue(payload["stream"])

    def test_build_payload_adds_input_image_for_edit_mode(self):
        image_url = "data:image/png;base64,abc123"

        payload = build_payload(
            "把这张图片改成金色科技风",
            size="1024x1024",
            quality="auto",
            image_data_url=image_url,
        )

        tool = payload["tools"][0]
        content = payload["input"][0]["content"]
        self.assertEqual(tool["action"], "edit")
        self.assertEqual(content[0], {"type": "input_text", "text": "把这张图片改成金色科技风"})
        self.assertEqual(content[1], {"type": "input_image", "image_url": image_url})

    def test_image_file_to_data_url_encodes_local_png(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            image_path = Path(tmp_dir) / "source.png"
            image_path.write_bytes(PNG_BYTES)

            data_url = image_file_to_data_url(image_path)

        self.assertEqual(data_url, f"data:image/png;base64,{PNG_B64}")

    def test_curl_command_streams_response_to_stdout(self):
        command = build_curl_command(Path("request.json"), Path("headers.cfg"))

        self.assertIn("-N", command)
        self.assertIn("--data-binary", command)
        self.assertIn("@request.json", command)
        self.assertNotIn("-o", command)
        self.assertIn("--config", command)
        self.assertIn("headers.cfg", command)
        self.assertNotIn("Authorization: Bearer sk-test", command)

        config = build_curl_config("sk-test")
        self.assertIn('header = "Authorization: Bearer sk-test"', config)

    def test_extracts_final_image_generation_result(self):
        sse = "\n".join(
            [
                _sse({"type": "response.created", "sequence_number": 0}),
                _sse(
                    {
                        "type": "response.image_generation_call.partial_image",
                        "partial_image_b64": "ignored",
                    }
                ),
                _sse(
                    {
                        "type": "response.output_item.done",
                        "item": {
                            "type": "image_generation_call",
                            "status": "completed",
                            "result": PNG_B64,
                            "revised_prompt": "poster prompt",
                        },
                    }
                ),
            ]
        )

        result = extract_image_result_from_sse(sse)

        self.assertEqual(result.image_b64, PNG_B64)
        self.assertEqual(result.revised_prompt, "poster prompt")
        self.assertEqual(result.source_event, "final")

    def test_falls_back_to_partial_image_when_final_result_is_absent(self):
        sse = "\n".join(
            [
                _sse({"type": "response.created", "sequence_number": 0}),
                _sse(
                    {
                        "type": "response.image_generation_call.partial_image",
                        "partial_image_b64": PNG_B64,
                    }
                ),
                _sse({"type": "response.completed", "response": {"status": "completed"}}),
            ]
        )

        result = extract_image_result_from_sse(sse)

        self.assertEqual(result.image_b64, PNG_B64)
        self.assertEqual(result.source_event, "partial")

    def test_raises_clear_error_when_no_image_is_present(self):
        sse = 'data: {"type":"response.completed","response":{"status":"completed"}}'

        with self.assertRaisesRegex(ValueError, "图片 base64"):
            extract_image_result_from_sse(sse)

    def test_detects_cloudflare_524_as_retryable(self):
        html = "<html><title>gptcodex.top | 524: A timeout occurred</title>Error code 524</html>"

        self.assertTrue(is_retryable_response(html))
        self.assertIn("Cloudflare 524", describe_response_problem(html))

    def test_detects_json_504_as_retryable(self):
        body = json.dumps(
            {
                "status": 504,
                "error_name": "origin_gateway_timeout",
                "retryable": True,
                "retry_after": 120,
            }
        )

        self.assertTrue(is_retryable_response(body))
        self.assertIn("504", describe_response_problem(body))


if __name__ == "__main__":
    unittest.main()
