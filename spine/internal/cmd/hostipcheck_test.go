package cmd

import "testing"

func TestValidatePiholeAuthResponse(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr bool
	}{
		{
			name:    "valid session",
			body:    `{"session":{"valid":true,"sid":"sid-123","csrf":"csrf-123","validity":1800}}`,
			wantErr: false,
		},
		{
			name:    "invalid session",
			body:    `{"session":{"valid":false,"message":"wrong password"}}`,
			wantErr: true,
		},
		{
			name:    "missing csrf",
			body:    `{"session":{"valid":true,"sid":"sid-123"}}`,
			wantErr: true,
		},
		{
			name:    "missing sid",
			body:    `{"session":{"valid":true,"csrf":"csrf-123"}}`,
			wantErr: true,
		},
		{
			name:    "missing session",
			body:    `{"error":{"message":"not ready"}}`,
			wantErr: true,
		},
		{
			name:    "malformed",
			body:    `not-json`,
			wantErr: true,
		},
		{
			name:    "empty",
			body:    ``,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validatePiholeAuthResponse([]byte(tt.body))
			if tt.wantErr && err == nil {
				t.Fatalf("expected error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("expected nil error, got %v", err)
			}
		})
	}
}
