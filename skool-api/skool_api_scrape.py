#!/usr/bin/env python3
"""
DWE Skool API Scraper — wraps skool_scraper.py and skool_unreads.py
for the mission-control-server. Outputs JSON matching the pipeline contract.

Usage:
  python3 skool_api_scrape.py --config /path/to/config.json [--unreads]

Env vars:
  SKOOL_AUTH_TOKEN  — required (from browser cookies)
  SKOOL_CLIENT_ID   — optional
"""

import os
import sys
import json
import argparse
import sqlite3
import shutil
import tempfile
from pathlib import Path

# Add script dir to path so we can import sibling modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from skool_scraper import SkoolScraper
from skool_unreads import SkoolUnreads


def extract_auth_token_from_chrome(profile_dir=None):
    """
    Extract SKOOL_AUTH_TOKEN from the persistent Chrome profile cookies.
    Falls back to env var if extraction fails.
    """
    if os.getenv('SKOOL_AUTH_TOKEN'):
        return os.getenv('SKOOL_AUTH_TOKEN')

    if not profile_dir:
        profile_dir = os.path.join(
            os.environ['HOME'],
            'openclaw/shared/config/skool-scraper/chrome-profile'
        )

    cookies_path = os.path.join(profile_dir, 'Default', 'Cookies')
    if not os.path.exists(cookies_path):
        # Try without Default subfolder
        cookies_path = os.path.join(profile_dir, 'Cookies')

    if not os.path.exists(cookies_path):
        return None

    # Copy to temp file (Chrome locks the DB)
    tmp = tempfile.mktemp(suffix='.db')
    try:
        shutil.copy2(cookies_path, tmp)
        conn = sqlite3.connect(tmp)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT value FROM cookies WHERE host_key LIKE '%skool.com%' AND name='auth_token'"
        )
        row = cursor.fetchone()
        conn.close()
        os.unlink(tmp)
        if row:
            return row[0]
    except Exception as e:
        print(f"Warning: Could not extract auth token from Chrome: {e}", file=sys.stderr)
        try:
            os.unlink(tmp)
        except:
            pass

    return None


def get_community_slug(url):
    """Extract slug from Skool URL."""
    import re
    match = re.search(r'skool\.com/([^?#/]+)', url)
    return match.group(1) if match else url


def scrape_communities(config, use_unreads=False):
    """
    Scrape all enabled communities using the API approach.
    Returns data in the same format as skool-scraper.js for pipeline compatibility.
    """
    auth_token = extract_auth_token_from_chrome()
    if not auth_token:
        return {
            'communities': [],
            'meta': {
                'scraped_at': __import__('datetime').datetime.now().isoformat(),
                'session_ok': False,
                'total_posts': 0,
                'error': 'No auth token — run Re-auth from dashboard or set SKOOL_AUTH_TOKEN'
            }
        }

    os.environ['SKOOL_AUTH_TOKEN'] = auth_token

    enabled = [c for c in config.get('communities', []) if c.get('enabled', True)]
    if not enabled:
        return {
            'communities': [],
            'meta': {
                'scraped_at': __import__('datetime').datetime.now().isoformat(),
                'session_ok': True,
                'total_posts': 0
            }
        }

    communities = []
    total_posts = 0

    for community in enabled:
        slug = get_community_slug(community['url'])
        name = community.get('name', slug)
        print(f"  Scraping: {name} (API)...", file=sys.stderr)

        try:
            if use_unreads:
                fetcher = SkoolUnreads()
                raw_posts = fetcher.get_unreads(slug, max_posts=50, since_hours=48)
            else:
                scraper = SkoolScraper()
                raw_posts = scraper.get_community_posts(slug, max_posts=30, delay=1.0)

            # Convert to the format expected by skool-pipeline.js
            posts = []
            for p in raw_posts:
                # Extract YouTube URLs from content
                import re
                content = p.get('content', '')
                yt_pattern = r'(?:https?://)?(?:www\.)?(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/live/)([a-zA-Z0-9_-]{11})'
                yt_matches = re.findall(yt_pattern, content)
                yt_urls = [f'https://www.youtube.com/watch?v={vid}' for vid in set(yt_matches)]

                # Extract non-YouTube links
                link_pattern = r'https?://[^\s<>"\')]+'
                all_links = re.findall(link_pattern, content)
                external_links = []
                for link in all_links:
                    if 'youtube.com' not in link and 'youtu.be' not in link and 'skool.com' not in link:
                        external_links.append({'text': link[:80], 'url': link})

                posts.append({
                    'title': p.get('title', ''),
                    'text': content[:2000],
                    'author': p.get('author', ''),
                    'timestamp': p.get('created_at', ''),
                    'postUrl': p.get('url', ''),
                    'youtubeUrls': yt_urls,
                    'links': external_links,
                    'likes': p.get('likes', 0),
                    'comments': p.get('comments', 0),
                    'community': name
                })

            communities.append({
                'name': name,
                'url': community['url'],
                'posts': posts
            })
            total_posts += len(posts)
            print(f"  ✅ {name}: {len(posts)} posts", file=sys.stderr)

        except Exception as e:
            print(f"  ❌ {name}: {e}", file=sys.stderr)
            communities.append({
                'name': name,
                'url': community['url'],
                'posts': [],
                'error': str(e)
            })

    return {
        'communities': communities,
        'meta': {
            'scraped_at': __import__('datetime').datetime.now().isoformat(),
            'session_ok': True,
            'total_posts': total_posts,
            'method': 'api'
        }
    }


def main():
    parser = argparse.ArgumentParser(description="DWE Skool API Scraper")
    parser.add_argument('--config', required=True, help='Path to config.json')
    parser.add_argument('--unreads', action='store_true', help='Only fetch unread posts')
    args = parser.parse_args()

    try:
        with open(args.config, 'r') as f:
            config = json.load(f)
    except Exception as e:
        print(json.dumps({'error': f'Config error: {e}'}))
        sys.exit(1)

    result = scrape_communities(config, use_unreads=args.unreads)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
