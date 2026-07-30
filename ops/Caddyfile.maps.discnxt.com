# Versioned metric assets and the viewer shell are served natively from the lab.
maps.discnxt.com {
	encode gzip zstd

	@epochPreflight {
		method OPTIONS
		path /epochs/*
	}
	handle @epochPreflight {
		header Access-Control-Allow-Headers "Range"
		header Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
		header Access-Control-Allow-Origin "*"
		header Access-Control-Max-Age "86400"
		respond "" 204
	}

	@epochAssets path /epochs/*
	handle @epochAssets {
		root * /var/sites/maps.discnxt.com/public
		header Access-Control-Allow-Origin "*"
		header Cache-Control "public, max-age=31536000, immutable"
		header Cross-Origin-Resource-Policy "cross-origin"
		file_server
	}

	handle {
		reverse_proxy 127.0.0.1:4310
	}

	header {
		Referrer-Policy "strict-origin-when-cross-origin"
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
	}
}
