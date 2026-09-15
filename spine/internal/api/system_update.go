package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/youeye-platform/YouEye/spine/internal/appliance"
	"github.com/youeye-platform/YouEye/spine/internal/systemupdate"
)

type systemUpdateService interface {
	Status() (systemupdate.Status, error)
	Discover(context.Context, systemupdate.SourceOptions) (systemupdate.Status, error)
	Stage(context.Context, systemupdate.SourceOptions) (systemupdate.Status, error)
	Activate(context.Context, bool) (systemupdate.Status, error)
}

type systemUpdateSourceRequest struct {
	Manifest       string `json:"manifest"`
	Signature      string `json:"signature,omitempty"`
	Provider       string `json:"provider,omitempty"`
	ReleasesAPI    string `json:"releases_api,omitempty"`
	Channel        string `json:"channel,omitempty"`
	Branch         string `json:"branch,omitempty"`
	ExactTag       string `json:"exact_tag,omitempty"`
	ManifestSHA256 string `json:"manifest_sha256,omitempty"`
	AllowTest      bool   `json:"allow_test_artifact,omitempty"`
	ReplaceFailed  bool   `json:"replace_failed,omitempty"`
}

type systemUpdateActivateRequest struct {
	Reboot bool `json:"reboot"`
}

func (s *Server) handleSystemUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.runtimeCapabilityGuard(w, appliance.ActionImageUpdate) {
		return
	}
	status, err := s.systemUpdate.Status()
	if err != nil {
		errorResponse(w, err.Error(), http.StatusConflict)
		return
	}
	jsonResponse(w, status)
}

func (s *Server) handleSystemUpdateCheck(w http.ResponseWriter, r *http.Request) {
	s.handleSystemUpdateSourceAction(w, r, s.systemUpdate.Discover)
}

func (s *Server) handleSystemUpdateStage(w http.ResponseWriter, r *http.Request) {
	s.handleSystemUpdateSourceAction(w, r, s.systemUpdate.Stage)
}

func (s *Server) handleSystemUpdateSourceAction(w http.ResponseWriter, r *http.Request, action func(context.Context, systemupdate.SourceOptions) (systemupdate.Status, error)) {
	if r.Method != http.MethodPost {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.runtimeCapabilityGuard(w, appliance.ActionImageUpdate) {
		return
	}
	var request systemUpdateSourceRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decodeOne(decoder, &request); err != nil {
		errorResponse(w, "a valid manifest request is required", http.StatusBadRequest)
		return
	}
	options, err := s.systemUpdateSourceOptions(r, request)
	if err != nil {
		errorResponse(w, err.Error(), http.StatusBadRequest)
		return
	}
	status, err := action(r.Context(), options)
	if err != nil {
		errorResponse(w, err.Error(), http.StatusConflict)
		return
	}
	jsonResponse(w, status)
}

func (s *Server) systemUpdateSourceOptions(r *http.Request, request systemUpdateSourceRequest) (systemupdate.SourceOptions, error) {
	manifest := strings.TrimSpace(request.Manifest)
	channel := strings.TrimSpace(request.Channel)
	if manifest != "" {
		if channel != "" || strings.TrimSpace(request.Branch) != "" || strings.TrimSpace(request.ExactTag) != "" || strings.TrimSpace(request.Provider) != "" || strings.TrimSpace(request.ReleasesAPI) != "" {
			return systemupdate.SourceOptions{}, errors.New("an exact manifest cannot be combined with a release provider, API, channel, or tag")
		}
		return systemupdate.SourceOptions{
			ManifestSource: manifest, SignatureSource: strings.TrimSpace(request.Signature),
			ExpectedManifestSHA256: strings.ToLower(strings.TrimSpace(request.ManifestSHA256)),
			Channel:                "exact-artifact", AllowTest: request.AllowTest, ReplaceFailed: request.ReplaceFailed,
		}, nil
	}
	if strings.TrimSpace(request.Signature) != "" {
		return systemupdate.SourceOptions{}, errors.New("a detached signature URL requires an exact manifest URL")
	}
	options, _, err := systemupdate.ResolveRelease(r.Context(), s.releaseHTTP, systemupdate.ReleaseSelection{
		Provider: strings.TrimSpace(request.Provider), ReleasesAPI: strings.TrimSpace(request.ReleasesAPI),
		Channel: channel, Branch: strings.TrimSpace(request.Branch), ExactTag: strings.TrimSpace(request.ExactTag), ManifestSHA256: strings.TrimSpace(request.ManifestSHA256),
	})
	if err != nil {
		return systemupdate.SourceOptions{}, err
	}
	options.AllowTest = request.AllowTest
	options.ReplaceFailed = request.ReplaceFailed
	return options, nil
}

func (s *Server) handleSystemUpdateActivate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		errorResponse(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.runtimeCapabilityGuard(w, appliance.ActionImageUpdate) {
		return
	}
	request := systemUpdateActivateRequest{}
	if r.Body != nil && r.ContentLength != 0 {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
		decoder.DisallowUnknownFields()
		if err := decodeOne(decoder, &request); err != nil {
			errorResponse(w, "a valid activation request is required", http.StatusBadRequest)
			return
		}
	}
	status, err := s.systemUpdate.Activate(r.Context(), request.Reboot)
	if err != nil {
		errorResponse(w, err.Error(), http.StatusConflict)
		return
	}
	jsonResponse(w, status)
}

func decodeOne(decoder *json.Decoder, target any) error {
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("request contains trailing JSON")
	}
	return nil
}
