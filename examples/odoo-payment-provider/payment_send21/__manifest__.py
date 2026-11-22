{
    'name': 'Payment Provider: send21',
    'version': '18.0.1.0.0',
    'category': 'Accounting/Payment Providers',
    'sequence': 350,
    'summary': "Crypto pay links: the customer signs and sends from their own wallet.",
    'description': " ",
    'author': 'send21',
    'website': 'https://send21.io',
    'depends': ['payment'],
    'data': [
        'security/ir.model.access.csv',
        'views/payment_send21_templates.xml',
        'views/payment_provider_views.xml',
        'data/payment_method_data.xml',
        'data/payment_provider_data.xml',
    ],
    'post_init_hook': 'post_init_hook',
    'uninstall_hook': 'uninstall_hook',
    'installable': True,
    'license': 'Other OSI approved licence',  # MIT, see LICENSE in the example folder
}
