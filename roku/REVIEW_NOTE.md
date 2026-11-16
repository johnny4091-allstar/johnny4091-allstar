# Notes for Roku (certification)

Copy the parts below into the Roku Developer Dashboard (testing information / sign-in details). Fill in the angle brackets. Never put a
real customer login or your admin login here.

## Testing information (paste)

Aurora is a client app for a user's own media server (an Emby server). It contains no media of its own. It plays what is on the server
the user signs in to, including the server's Live TV: a live TV playlist that the person who runs the server sets up. The app supplies
no channels itself. Live TV is part of the app for every account, including the demo account below.

How to review it:

1. Open the app. On the sign-in screen choose Username and Password and enter the demo account:
   - Username: `<demo username>`
   - Password: `<demo password>`
2. Choose Sign in. Pick Movies or TV Shows, choose a title and press OK to play. Pick Live TV, choose a category, then a channel
   (up and down on the remote change channel while watching). (<say what the demo library contains>)
3. Press Back to return; Sign out is the last item in the menu.
4. No payment, purchase or account creation takes place in the app. Access to a user's server account is arranged outside the app by
   the person who runs the server.

The app uses the network only to talk to the user's server and the Live TV provider that server's administrator configured. No
advertising or analytics. Privacy policy: <https://your-website/privacy/>. Contact: <your email>.

## The demo account (same one as for Apple; about 10 minutes the first time)

The reviewer must see the same app your customers see, so the demo account is an ordinary account, not a special mode.

1. In the Aurora app: Admin → Users → **Add user**. Username `roku-review` (or anything), a strong password. Not an administrator.
2. On the user's page set **No end date** and save, so it can't expire during the review.
3. Give it something to play: a library of a few free or public-domain videos, and Live TV on like any other account.
4. Try it on a Roku first, then paste the details above.

Keep the server and Aurora Guard on and reachable from the internet for the whole review (it can take days).
