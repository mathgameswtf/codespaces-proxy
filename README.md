# codespaces-proxy
A proxy for school, that can be used to unblock absolutely any website ever built for GitHub.

# Using it
There are 2 ways how to use this, one that probably will work at school, and one that is for an at-home usecase.

## Over the cloud (recomended)
Login or create a github account, then click on the green "Code" the click into the "Codespaces" tab then click "create new codespace on main." wait for the codespace to load(wait for terminal to appear at the bottom), then paste in this command:
npm install http-proxy-middleware express

After doing that, you can start it by running "node main.js" in the terminal, once the notification comes up, click on open in browser

As long as you don't use this too much(eg. over 1000 requests a day) it should be completly free!