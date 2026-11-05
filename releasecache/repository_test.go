package releasecache

import "testing"

func TestRepositorySourceBoundaries(t *testing.T) {
	for _, test := range []struct{ url, adapter, api string }{
		{OfficialRepository, "github", "https://api.github.com/repos/YouEye-Platform/YouEye/releases"},
		{"https://code.example.test/owner/YouEye.git/", "custom", "https://code.example.test/api/v1/repos/owner/YouEye/releases"},
		{"https://github.com/another/YouEye", "github", "https://api.github.com/repos/another/YouEye/releases"},
	} {
		source, err := ParseRepositorySource(test.url)
		if err != nil || source.Adapter != test.adapter || source.ReleasesAPI != test.api {
			t.Fatalf("source %q: %+v %v", test.url, source, err)
		}
		url, err := RepositoryURLFromAPI(source.Adapter, source.ReleasesAPI)
		if err != nil || url != source.URL {
			t.Fatalf("repository round trip: %q %v", url, err)
		}
	}
	for _, raw := range []string{"http://code.example.test/owner/YouEye", "https://user:password@code.example.test/owner/YouEye", "https://code.example.test/owner/YouEye?key=value", "https://code.example.test/owner/YouEye#branch", "https://code.example.test/owner/../YouEye", "https://code.example.test/owner%2Fother/YouEye", "https://code.example.test/owner/YouEye/releases", "https://code.example.test/owner"} {
		if _, err := ParseRepositorySource(raw); err == nil {
			t.Errorf("unsafe repository accepted: %q", raw)
		}
	}
}
