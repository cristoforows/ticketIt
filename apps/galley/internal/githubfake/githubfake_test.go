package githubfake

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"testing"
)

func TestStart_HealthzAndIdentityPresetsControlWhatUserReturns(t *testing.T) {
	s := Start(TestOwnerIdentity)
	defer s.Close()

	resp, err := http.Get(s.URL + "/_fake/healthz")
	if err != nil {
		t.Fatalf("healthz request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: got status %d, want 200", resp.StatusCode)
	}

	assertRoundTripIdentity(t, s, TestOwnerIdentity)

	setIdentityPreset(t, s, "non-owner")
	assertRoundTripIdentity(t, s, NonOwnerIdentity)

	setIdentityPreset(t, s, "owner")
	assertRoundTripIdentity(t, s, TestOwnerIdentity)
}

func TestStart_SetIdentityRejectsUnknownPreset(t *testing.T) {
	s := Start(TestOwnerIdentity)
	defer s.Close()

	resp, err := http.Post(s.URL+"/_fake/identity", "application/json", strings.NewReader(`{"preset":"bogus"}`))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", resp.StatusCode)
	}
}

func TestStart_OverlappingCodesAndTokensKeepTheirIdentities(t *testing.T) {
	s := New(t, TestOwnerIdentity)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	authorize := func() string {
		t.Helper()
		resp, err := client.Get(s.URL + "/login/oauth/authorize?" + url.Values{
			"client_id": {s.ClientID}, "redirect_uri": {"https://example.invalid/callback"},
		}.Encode())
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		loc, err := resp.Location()
		if err != nil || loc.Query().Get("code") == "" {
			t.Fatalf("authorize Location = %v, error = %v", loc, err)
		}
		return loc.Query().Get("code")
	}
	exchange := func(code string) string {
		t.Helper()
		resp, err := client.PostForm(s.URL+"/login/oauth/access_token", url.Values{
			"client_id": {s.ClientID}, "client_secret": {s.ClientSecret}, "code": {code},
		})
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			AccessToken string `json:"access_token"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != http.StatusOK || body.AccessToken == "" {
			t.Fatalf("exchange status = %d, body = %+v, error = %v", resp.StatusCode, body, err)
		}
		return body.AccessToken
	}
	ownerCode := authorize()
	setIdentityPreset(t, s, "non-owner")
	nonOwnerCode := authorize()
	ownerToken := exchange(ownerCode)
	nonOwnerToken := exchange(nonOwnerCode)
	replayed, err := client.PostForm(s.URL+"/login/oauth/access_token", url.Values{
		"client_id": {s.ClientID}, "client_secret": {s.ClientSecret}, "code": {ownerCode},
	})
	if err != nil {
		t.Fatal(err)
	}
	replayed.Body.Close()
	if replayed.StatusCode != http.StatusBadRequest {
		t.Fatalf("replayed code status = %d, want 400", replayed.StatusCode)
	}
	for _, tc := range []struct {
		token string
		want  Identity
	}{
		{ownerToken, TestOwnerIdentity},
		{nonOwnerToken, NonOwnerIdentity},
	} {
		req, err := http.NewRequest(http.MethodGet, s.URL+"/user", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+tc.token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var got Identity
		decodeErr := json.NewDecoder(resp.Body).Decode(&got)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || decodeErr != nil || got != tc.want {
			t.Errorf("/user status = %d, identity = %+v, error = %v; want %+v", resp.StatusCode, got, decodeErr, tc.want)
		}
	}
	var wg sync.WaitGroup
	started := make(chan struct{}, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() {
			select {
			case started <- struct{}{}:
			default:
			}
		}()
		for i := range 100 {
			req, err := http.NewRequest(http.MethodGet, s.URL+"/user", nil)
			if err != nil {
				t.Error(err)
				return
			}
			req.Header.Set("Authorization", "Bearer "+ownerToken)
			resp, err := client.Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			resp.Body.Close()
			if i == 0 {
				started <- struct{}{}
			}
			if resp.StatusCode != http.StatusOK {
				t.Errorf("concurrent /user status = %d, want 200", resp.StatusCode)
			}
		}
	}()
	<-started
	for range 20 {
		s.SetIdentity(TestOwnerIdentity)
		exchange(authorize())
	}
	wg.Wait()
}

// assertRoundTripIdentity drives a full authorize -> token exchange ->
// identity fetch against s, exactly as internal/auth.GitHubClient would,
// to prove /_fake/identity actually changes what the next authorization
// reports through /user.
func assertRoundTripIdentity(t *testing.T, s *Server, want Identity) {
	t.Helper()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	client := &http.Client{
		Jar: jar,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	redirectURI := "https://example.invalid/callback"
	authorizeURL := s.URL + "/login/oauth/authorize?" + url.Values{
		"client_id":    {s.ClientID},
		"redirect_uri": {redirectURI},
		"state":        {"fixed-state"},
	}.Encode()

	resp, err := client.Get(authorizeURL)
	if err != nil {
		t.Fatalf("authorize request failed: %v", err)
	}
	loc, err := resp.Location()
	resp.Body.Close()
	if err != nil {
		t.Fatalf("authorize response missing Location: %v", err)
	}
	code := loc.Query().Get("code")
	if code == "" {
		t.Fatalf("authorize redirect missing code: %s", loc)
	}

	tokenResp, err := client.PostForm(s.URL+"/login/oauth/access_token", url.Values{
		"client_id":     {s.ClientID},
		"client_secret": {s.ClientSecret},
		"code":          {code},
	})
	if err != nil {
		t.Fatalf("token exchange failed: %v", err)
	}
	defer tokenResp.Body.Close()
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(tokenResp.Body).Decode(&token); err != nil {
		t.Fatalf("failed to decode token response: %v", err)
	}
	if token.AccessToken == "" {
		t.Fatalf("token exchange returned no access_token")
	}

	req, err := http.NewRequest(http.MethodGet, s.URL+"/user", nil)
	if err != nil {
		t.Fatalf("failed to build /user request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token.AccessToken)
	userResp, err := client.Do(req)
	if err != nil {
		t.Fatalf("/user request failed: %v", err)
	}
	defer userResp.Body.Close()
	if userResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(userResp.Body)
		t.Fatalf("/user: got status %d, body %s", userResp.StatusCode, body)
	}
	var got Identity
	if err := json.NewDecoder(userResp.Body).Decode(&got); err != nil {
		t.Fatalf("failed to decode /user response: %v", err)
	}
	if got != want {
		t.Fatalf("/user returned %+v, want %+v", got, want)
	}
}

func setIdentityPreset(t *testing.T, s *Server, preset string) {
	t.Helper()
	body, err := json.Marshal(struct {
		Preset string `json:"preset"`
	}{Preset: preset})
	if err != nil {
		t.Fatalf("failed to marshal preset body: %v", err)
	}
	resp, err := http.Post(s.URL+"/_fake/identity", "application/json", strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("failed to set identity preset %q: %v", preset, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("set identity preset %q: got status %d, want 204", preset, resp.StatusCode)
	}
}
