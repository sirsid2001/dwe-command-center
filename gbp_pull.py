#!/usr/bin/env python3
"""
GBP Data Pull — caches Google Business Profile status for the dashboard
Runs every 6 hours via launchd (ai.dwe.gbp-pull)
Saves to ~/mission-control-server/gbp_cache.json

Fetches: listing status, rating, review count, recent reviews, search impressions
"""
import json, os, sys
from datetime import datetime, timezone

TOKEN_PATH  = os.path.expanduser('~/.openclaw/skills/gmail-api/token_gbp.json')
CACHE_PATH  = os.path.expanduser('~/mission-control-server/gbp_cache.json')
LOG_PATH    = os.path.expanduser('~/openclaw/logs/gbp-pull.log')

def log(msg):
    with open(LOG_PATH, 'a') as f:
        f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")

try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    import urllib.request, urllib.error
except ImportError:
    log("ERROR: google-auth not installed")
    sys.exit(1)

def get_creds():
    creds = Credentials.from_authorized_user_file(TOKEN_PATH)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(TOKEN_PATH, 'w') as f:
            f.write(creds.to_json())
    return creds

def gbp_get(creds, url):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {creds.token}'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def pull():
    log("Starting GBP pull...")
    creds = get_creds()

    # Step 1: get account
    accounts_data = gbp_get(creds, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts')
    accounts = accounts_data.get('accounts', [])
    if not accounts:
        log("ERROR: No GBP accounts found")
        write_error_cache("No GBP accounts found")
        return

    account_name = accounts[0]['name']  # e.g. accounts/123456789
    account_type = accounts[0].get('type', '')
    log(f"Account: {account_name} ({account_type})")

    # Step 2: get locations under account
    locs_data = gbp_get(creds,
        f'https://mybusinessaccountmanagement.googleapis.com/v1/{account_name}/locations'
        '?readMask=name,title,websiteUri,storefrontAddress,regularHours,metadata'
    )
    locations = locs_data.get('locations', [])
    if not locations:
        log("ERROR: No locations found")
        write_error_cache("No locations found under account")
        return

    # Use first location (TVC has one listing)
    loc = locations[0]
    location_name = loc['name']  # e.g. locations/ABC123
    log(f"Location: {location_name} — {loc.get('title','?')}")

    # Step 3: get location detail with reviews + metadata
    detail = gbp_get(creds,
        f'https://mybusinessinformation.googleapis.com/v1/{location_name}'
        '?readMask=name,title,websiteUri,regularHours,metadata,profile'
    )

    metadata = detail.get('metadata', {})
    listing_status = 'verified' if metadata.get('hasGoogleUpdated') is not None else 'unknown'
    # mapsUri presence = listing is live
    maps_uri = metadata.get('mapsUri', '')
    new_review_uri = metadata.get('newReviewUri', '')

    # Step 4: get reviews
    reviews_data = gbp_get(creds,
        f'https://mybusinessaccountmanagement.googleapis.com/v1/{location_name}/reviews'
        '?pageSize=5&orderBy=updateTime desc'
    )
    reviews = reviews_data.get('reviews', [])
    avg_rating = reviews_data.get('averageRating', None)
    total_reviews = reviews_data.get('totalReviewCount', 0)

    recent_reviews = []
    for r in reviews[:3]:
        recent_reviews.append({
            'author': r.get('reviewer', {}).get('displayName', 'Anonymous'),
            'rating': r.get('starRating', ''),
            'text': r.get('comment', '')[:200],
            'time': r.get('updateTime', '')
        })

    cache = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'account': account_name,
        'location': location_name,
        'name': detail.get('title', loc.get('title', 'The Veterans Consultant')),
        'website': detail.get('websiteUri', ''),
        'mapsUri': maps_uri,
        'newReviewUri': new_review_uri,
        'status': 'live' if maps_uri else 'unlisted',
        'verified': metadata.get('hasGoogleUpdated') is not None,
        'avgRating': avg_rating,
        'totalReviews': total_reviews,
        'recentReviews': recent_reviews,
        'error': None
    }

    with open(CACHE_PATH, 'w') as f:
        json.dump(cache, f, indent=2)

    log(f"GBP pull complete. Status: {cache['status']} | Rating: {avg_rating} ({total_reviews} reviews)")
    print(json.dumps(cache, indent=2))

def write_error_cache(msg):
    cache = {
        'updated': datetime.now(timezone.utc).isoformat(),
        'status': 'error',
        'error': msg,
        'avgRating': None,
        'totalReviews': 0,
        'recentReviews': []
    }
    with open(CACHE_PATH, 'w') as f:
        json.dump(cache, f, indent=2)

if __name__ == '__main__':
    try:
        pull()
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        msg = f"HTTP {e.code}: {body[:200]}"
        log(f"ERROR: {msg}")
        write_error_cache(msg)
    except Exception as e:
        log(f"ERROR: {e}")
        write_error_cache(str(e))
